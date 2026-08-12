import {
  createLocalAgentActor,
  type LocalAgentActor,
  type LocalAgentMachineInput,
} from "../models/local-agent.machine.js";
import {
  type AgentSignal,
  type AutonomyContract,
  createLocalMissionActor,
  type LocalMissionActor,
  type MissionCommand,
  type MissionMessage,
  type MissionTemplateSnapshot,
  missionAvailableCommands,
} from "../models/local-mission.machine.js";
import {
  type AgentActivityEntry,
  type LocalAgentState,
  type MissionState,
  type MissionTemplateAgent,
  sanitizeAgentActivity,
} from "../models/local-workspace.types.js";
import type { ClockPort } from "../ports/clock.js";

export type TeamTemplate = Readonly<{
  templateId: string;
  revision: number;
  name: string;
  origin: "built_in" | "user" | "duplicate";
  agents: readonly MissionTemplateAgent[];
}>;

export type LocalAgentWorkerResult = Readonly<{
  signal: Extract<AgentSignal, { kind: "shared_message" }>;
  activity: AgentActivityEntry;
}>;

export interface LocalAgentProcessPort {
  start(agentId: string): Promise<Readonly<{ processId: number }>>;
  send(agentId: string, content: string): Promise<LocalAgentWorkerResult>;
  stop(agentId: string): Promise<"stopped" | "absent">;
}

export interface SnapshotHashPort {
  digest(value: string): string;
}

export type AgentProfileProjection = Readonly<{
  agentId: string;
  missionId: string;
  role: string;
  state: LocalAgentState;
  parentAgentId: string | null;
  capabilities: readonly string[];
  effectivePermissions: readonly string[];
  activity: readonly AgentActivityEntry[];
}>;

export type WorkspaceProjection = Readonly<{
  mission: Readonly<{
    missionId: string;
    state: MissionState;
    availableCommands: readonly MissionCommand[];
    templateSnapshot: MissionTemplateSnapshot | null;
  }>;
  messages: readonly MissionMessage[];
  agents: readonly AgentProfileProjection[];
}>;

export type LaunchMissionCommand = Readonly<{
  template: TeamTemplate;
  enabledAgentIds: readonly string[];
  autonomyContract: AutonomyContract;
}>;

type ServiceDependencies = Readonly<{
  missionId: string;
  ownerId: string;
  processPort: LocalAgentProcessPort;
  clock: ClockPort;
  hash: SnapshotHashPort;
}>;

const agentState = (actor: LocalAgentActor): LocalAgentState => String(actor.getSnapshot().value) as LocalAgentState;

const missionState = (actor: LocalMissionActor): MissionState => String(actor.getSnapshot().value) as MissionState;

const canonicalSnapshotContent = (
  missionId: string,
  template: TeamTemplate,
  normalizedTeam: readonly MissionTemplateAgent[],
  autonomyContract: AutonomyContract,
): string =>
  JSON.stringify({
    missionId,
    sourceTemplateId: template.templateId,
    sourceRevision: template.revision,
    normalizedTeam,
    autonomyContract,
  });

export class LocalAgentWorkspaceService {
  readonly #mission: LocalMissionActor;
  readonly #agents = new Map<string, LocalAgentActor>();
  readonly #technicalActivity = new Map<string, AgentActivityEntry[]>();
  readonly #dependencies: ServiceDependencies;
  #messageSequence = 0;

  public constructor(dependencies: ServiceDependencies) {
    this.#dependencies = dependencies;
    this.#mission = createLocalMissionActor({ missionId: dependencies.missionId, ownerId: dependencies.ownerId });
  }

  public projection(): WorkspaceProjection {
    const missionSnapshot = this.#mission.getSnapshot();
    return {
      mission: {
        missionId: missionSnapshot.context.missionId,
        state: missionState(this.#mission),
        availableCommands: missionAvailableCommands(missionSnapshot.value),
        templateSnapshot: missionSnapshot.context.templateSnapshot,
      },
      messages: missionSnapshot.context.messages,
      agents: [...this.#agents.values()].map((actor) => {
        const snapshot = actor.getSnapshot();
        return {
          agentId: snapshot.context.agentId,
          missionId: snapshot.context.missionId,
          role: snapshot.context.role,
          state: agentState(actor),
          parentAgentId: snapshot.context.parentAgentId,
          capabilities: snapshot.context.capabilities,
          effectivePermissions: snapshot.context.effectivePermissions,
          activity: [...snapshot.context.activity, ...(this.#technicalActivity.get(snapshot.context.agentId) ?? [])],
        };
      }),
    };
  }

  public async launch(command: LaunchMissionCommand): Promise<WorkspaceProjection> {
    this.#requireCommand("launch");
    const normalizedTeam = command.template.agents.filter((agent) => command.enabledAgentIds.includes(agent.agentId));
    const sealedAt = this.#dependencies.clock.now();
    const content = canonicalSnapshotContent(
      this.#dependencies.missionId,
      command.template,
      normalizedTeam,
      command.autonomyContract,
    );
    const templateSnapshot: MissionTemplateSnapshot = {
      snapshotId: `${this.#dependencies.missionId}:snapshot:1`,
      missionId: this.#dependencies.missionId,
      sourceTemplateId: command.template.templateId,
      sourceRevision: command.template.revision,
      normalizedTeam,
      autonomyContract: structuredClone(command.autonomyContract),
      contentHash: this.#dependencies.hash.digest(content),
      sealedAt,
    };
    this.#mission.send({
      type: "MISSION_LAUNCH_REQUESTED",
      source: "human",
      ownerId: this.#dependencies.ownerId,
      snapshot: templateSnapshot,
    });
    if (missionState(this.#mission) !== "pending") throw new Error("mission model rejected launch");

    for (const agent of normalizedTeam) {
      const input: LocalAgentMachineInput = {
        agentId: agent.agentId,
        missionId: this.#dependencies.missionId,
        ownerId: this.#dependencies.ownerId,
        role: agent.role,
        parentAgentId: null,
        capabilities: agent.capabilities,
        effectivePermissions: command.autonomyContract.allowedToolIds,
        retryLimits: command.autonomyContract.retryLimits,
        humanRetryAttempt: command.autonomyContract.validationThresholds.humanRetryAttempt,
      };
      const actor = createLocalAgentActor(input);
      this.#agents.set(agent.agentId, actor);
      await this.#startAgent(actor, `launch:${agent.agentId}:0`, `reservation:${agent.agentId}:0`);
    }
    this.#mission.send({
      type: "MISSION_ACTIVATION_EVALUATED",
      source: "system",
      requiredAgents: normalizedTeam
        .filter((agent) => agent.required)
        .map((agent) => ({ agentId: agent.agentId, state: agentState(this.#agent(agent.agentId)) })),
    });
    if (missionState(this.#mission) !== "active") throw new Error("mission model rejected activation");
    return this.projection();
  }

  public async sendHumanMessage(content: string): Promise<WorkspaceProjection> {
    this.#requireCommand("send_message");
    const before = this.#mission.getSnapshot().context.messages.length;
    const createdAt = this.#dependencies.clock.now();
    this.#mission.send({
      type: "HUMAN_MESSAGE_SUBMITTED",
      source: "human",
      ownerId: this.#dependencies.ownerId,
      message: {
        messageId: `human:${++this.#messageSequence}`,
        author: { kind: "human", id: this.#dependencies.ownerId, displayName: "Owner" },
        visibility: { kind: "mission_shared", participantIds: [] },
        kind: "conversation",
        content,
        createdAt,
      },
    });
    if (this.#mission.getSnapshot().context.messages.length === before)
      throw new Error("mission model rejected message");

    for (const actor of this.#agents.values()) {
      if (agentState(actor) !== "active") continue;
      const result = await this.#dependencies.processPort.send(actor.getSnapshot().context.agentId, content);
      this.#appendTechnicalActivity(actor.getSnapshot().context.agentId, result.activity);
      actor.send({ type: "AGENT_SIGNAL_RECORDED", source: "ai", signal: result.signal });
      this.#mission.send({
        type: "AGENT_SIGNAL_RECORDED",
        source: "ai",
        agentId: actor.getSnapshot().context.agentId,
        signal: result.signal,
      });
    }
    return this.projection();
  }

  public async pause(): Promise<WorkspaceProjection> {
    this.#requireCommand("pause");
    this.#mission.send({ type: "MISSION_PAUSE_REQUESTED", source: "human", ownerId: this.#dependencies.ownerId });
    if (missionState(this.#mission) !== "pausing") throw new Error("mission model rejected pause");
    for (const actor of this.#agents.values()) await this.#interruptAgent(actor);
    this.#mission.send({
      type: "MISSION_PAUSE_QUIESCENCE_EVALUATED",
      source: "system",
      agentStates: [...this.#agents.values()].map(agentState),
      openStartIntents: 0,
    });
    if (missionState(this.#mission) !== "paused") throw new Error("mission model rejected pause quiescence");
    return this.projection();
  }

  public async resume(): Promise<WorkspaceProjection> {
    this.#requireCommand("resume");
    this.#mission.send({ type: "MISSION_RESUME_REQUESTED", source: "human", ownerId: this.#dependencies.ownerId });
    if (missionState(this.#mission) !== "pending") throw new Error("mission model rejected resume");
    for (const actor of this.#agents.values()) {
      if (agentState(actor) !== "interrupted") continue;
      const token = `resume:${actor.getSnapshot().context.agentId}:${actor.getSnapshot().context.startAttempt}`;
      actor.send({ type: "AGENT_RESTART_AUTHORIZED", source: "system", launchToken: token });
      const started = await this.#dependencies.processPort.start(actor.getSnapshot().context.agentId);
      actor.send({ type: "PROCESS_STARTED", source: "tool", launchToken: token, processId: started.processId });
    }
    this.#mission.send({
      type: "MISSION_ACTIVATION_EVALUATED",
      source: "system",
      requiredAgents: [...this.#agents.values()].map((actor) => ({
        agentId: actor.getSnapshot().context.agentId,
        state: agentState(actor),
      })),
    });
    if (missionState(this.#mission) !== "active") throw new Error("mission model rejected resumed activation");
    return this.projection();
  }

  public async cancel(): Promise<WorkspaceProjection> {
    this.#requireCommand("cancel");
    this.#mission.send({ type: "MISSION_CANCEL_REQUESTED", source: "human", ownerId: this.#dependencies.ownerId });
    if (missionState(this.#mission) === "cancelled") return this.projection();
    if (missionState(this.#mission) !== "cancelling") throw new Error("mission model rejected cancellation");
    for (const actor of this.#agents.values()) await this.#cancelAgent(actor);
    const states = [...this.#agents.values()].map(agentState);
    const terminal = states.every((state) => state === "completed" || state === "cancelled" || state === "failed");
    this.#mission.send({
      type: "MISSION_QUIESCENCE_EVALUATED",
      source: "system",
      allAgentsQuiescent: terminal,
      openSubagentRequests: 0,
      liveProcessCount: terminal ? 0 : states.length,
    });
    if (missionState(this.#mission) !== "cancelled") throw new Error("mission model rejected cancellation quiescence");
    return this.projection();
  }

  #requireCommand(command: MissionCommand): void {
    if (!missionAvailableCommands(this.#mission.getSnapshot().value).includes(command)) {
      throw new Error(`${command} is not available in mission state ${missionState(this.#mission)}`);
    }
  }

  #agent(agentId: string): LocalAgentActor {
    const actor = this.#agents.get(agentId);
    if (!actor) throw new Error(`agent ${agentId} does not exist`);
    return actor;
  }

  async #startAgent(actor: LocalAgentActor, launchToken: string, reservationId: string): Promise<void> {
    actor.send({ type: "AGENT_START_AUTHORIZED", source: "system", launchToken, reservationId });
    if (agentState(actor) !== "starting")
      throw new Error(`agent ${actor.getSnapshot().context.agentId} rejected start`);
    const started = await this.#dependencies.processPort.start(actor.getSnapshot().context.agentId);
    actor.send({ type: "PROCESS_STARTED", source: "tool", launchToken, processId: started.processId });
    if (agentState(actor) !== "active")
      throw new Error(`agent ${actor.getSnapshot().context.agentId} rejected process ack`);
  }

  async #interruptAgent(actor: LocalAgentActor): Promise<void> {
    const id = actor.getSnapshot().context.agentId;
    actor.send({ type: "AGENT_INTERRUPT_REQUESTED", source: "system", reason: "mission-paused" });
    actor.send({ type: "DESCENDANTS_QUIESCENT", source: "system", descendantStates: [], openLaunchIntents: 0 });
    const outcome = await this.#dependencies.processPort.stop(id);
    actor.send({
      type: outcome === "stopped" ? "PROCESS_STOPPED" : "LOCAL_PROCESS_ABSENT",
      source: "tool",
      stopToken: `stop:${id}`,
    });
    if (agentState(actor) !== "interrupted") throw new Error(`agent ${id} rejected restartable stop`);
  }

  async #cancelAgent(actor: LocalAgentActor): Promise<void> {
    const id = actor.getSnapshot().context.agentId;
    const state = agentState(actor);
    if (state === "completed" || state === "cancelled" || state === "failed") return;
    actor.send({ type: "AGENT_CANCEL_REQUESTED", source: "system", reason: "mission-cancelled" });
    actor.send({ type: "DESCENDANTS_QUIESCENT", source: "system", descendantStates: [], openLaunchIntents: 0 });
    const outcome = await this.#dependencies.processPort.stop(id);
    actor.send({
      type: outcome === "stopped" ? "PROCESS_STOPPED" : "LOCAL_PROCESS_ABSENT",
      source: "tool",
      stopToken: `stop:${id}`,
    });
    if (agentState(actor) !== "cancelled") throw new Error(`agent ${id} rejected terminal stop`);
  }

  #appendTechnicalActivity(agentId: string, entry: AgentActivityEntry): void {
    const entries = this.#technicalActivity.get(agentId) ?? [];
    this.#technicalActivity.set(agentId, [...entries, sanitizeAgentActivity(entry)]);
  }
}
