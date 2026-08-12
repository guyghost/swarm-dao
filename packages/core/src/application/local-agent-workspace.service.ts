import type { Snapshot } from "xstate";
import {
  createLocalAgentActor,
  type LocalAgentActor,
  type LocalAgentContext,
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
  lineage?: Readonly<{ sourceTemplateId: string; sourceRevision: number }>;
}>;

export type WorkspaceRecoveryProjection = Readonly<{
  required: boolean;
  previousState: MissionState;
  recoveredAt: string;
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
    recovery: WorkspaceRecoveryProjection | null;
  }>;
  messages: readonly MissionMessage[];
  agents: readonly AgentProfileProjection[];
}>;

export type LaunchMissionCommand = Readonly<{
  template: TeamTemplate;
  enabledAgentIds: readonly string[];
  autonomyContract: AutonomyContract;
}>;

export type PersistedAgentRecord = Readonly<{
  agentId: string;
  snapshot: Snapshot<unknown>;
}>;

export type LocalWorkspacePersistedState = Readonly<{
  missionSnapshot: Snapshot<unknown>;
  agents: readonly PersistedAgentRecord[];
  technicalActivity: readonly Readonly<{ agentId: string; entries: readonly AgentActivityEntry[] }>[];
  userTemplateRevisions: readonly TeamTemplate[];
  lastAutonomyContract: AutonomyContract | null;
  messageSequence: number;
}>;

export interface LocalWorkspacePersistencePort {
  save(state: LocalWorkspacePersistedState): Promise<void>;
}

export type CreateTeamTemplateCommand = Readonly<{
  templateId: string;
  name: string;
  agents: readonly MissionTemplateAgent[];
}>;

export type DuplicateTeamTemplateCommand = Readonly<{
  sourceTemplateId: string;
  sourceRevision: number;
  templateId: string;
  name: string;
}>;

export type SaveTeamTemplateRevisionCommand = Readonly<{
  templateId: string;
  expectedRevision: number;
  name: string;
  agents: readonly MissionTemplateAgent[];
}>;

type ServiceDependencies = Readonly<{
  missionId: string;
  ownerId: string;
  processPort: LocalAgentProcessPort;
  clock: ClockPort;
  hash: SnapshotHashPort;
  builtInTemplates?: readonly TeamTemplate[];
  restoredState?: LocalWorkspacePersistedState;
  persistence?: LocalWorkspacePersistencePort;
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
  #mission: LocalMissionActor;
  readonly #agents = new Map<string, LocalAgentActor>();
  readonly #technicalActivity = new Map<string, AgentActivityEntry[]>();
  readonly #dependencies: ServiceDependencies;
  readonly #templates: TeamTemplate[];
  #lastAutonomyContract: AutonomyContract | null;
  #lastDurableState: LocalWorkspacePersistedState;
  #messageSequence = 0;

  public constructor(dependencies: ServiceDependencies) {
    this.#dependencies = dependencies;
    this.#templates = [...(dependencies.builtInTemplates ?? [])];
    this.#lastAutonomyContract = dependencies.restoredState?.lastAutonomyContract ?? null;
    if (dependencies.restoredState) {
      this.#mission = createLocalMissionActor(
        { missionId: dependencies.missionId, ownerId: dependencies.ownerId },
        dependencies.restoredState.missionSnapshot,
      );
      for (const record of dependencies.restoredState.agents) {
        const input = this.#agentInputFromSnapshot(record.snapshot);
        this.#agents.set(record.agentId, createLocalAgentActor(input, record.snapshot));
      }
      for (const record of dependencies.restoredState.technicalActivity) {
        this.#technicalActivity.set(record.agentId, record.entries.map(sanitizeAgentActivity));
      }
      this.#templates.push(
        ...dependencies.restoredState.userTemplateRevisions.map((template) => structuredClone(template)),
      );
      this.#messageSequence = dependencies.restoredState.messageSequence;
    } else {
      this.#mission = createLocalMissionActor({ missionId: dependencies.missionId, ownerId: dependencies.ownerId });
    }
    this.#lastDurableState = this.persistedState();
  }

  public projection(): WorkspaceProjection {
    const missionSnapshot = this.#mission.getSnapshot();
    return {
      mission: {
        missionId: missionSnapshot.context.missionId,
        state: missionState(this.#mission),
        availableCommands: missionAvailableCommands(missionSnapshot.value),
        templateSnapshot: missionSnapshot.context.templateSnapshot,
        recovery: missionSnapshot.context.recovery,
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

  public templates(): readonly TeamTemplate[] {
    const latest = new Map<string, TeamTemplate>();
    for (const template of this.#templates) {
      const current = latest.get(template.templateId);
      if (!current || current.revision < template.revision) latest.set(template.templateId, template);
    }
    return [...latest.values()].map((template) => structuredClone(template));
  }

  public lastAutonomyContract(): AutonomyContract | null {
    return this.#lastAutonomyContract ? structuredClone(this.#lastAutonomyContract) : null;
  }

  public persistedState(): LocalWorkspacePersistedState {
    return {
      missionSnapshot: this.#mission.getPersistedSnapshot(),
      agents: [...this.#agents.entries()].map(([agentId, actor]) => ({
        agentId,
        snapshot: actor.getPersistedSnapshot(),
      })),
      technicalActivity: [...this.#technicalActivity.entries()].map(([agentId, entries]) => ({
        agentId,
        entries: entries.map(sanitizeAgentActivity),
      })),
      userTemplateRevisions: this.#templates
        .filter((template) => template.origin !== "built_in")
        .map((template) => structuredClone(template)),
      lastAutonomyContract: this.#lastAutonomyContract ? structuredClone(this.#lastAutonomyContract) : null,
      messageSequence: this.#messageSequence,
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

    this.#lastAutonomyContract = structuredClone(command.autonomyContract);
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
      actor.send({
        type: "AGENT_START_AUTHORIZED",
        source: "system",
        launchToken: `launch:${agent.agentId}:0`,
        reservationId: `reservation:${agent.agentId}:0`,
      });
      if (agentState(actor) !== "starting") throw new Error(`agent ${agent.agentId} rejected start`);
    }
    await this.#commit();
    for (const actor of this.#agents.values()) await this.#startAuthorizedAgent(actor);
    this.#mission.send({
      type: "MISSION_ACTIVATION_EVALUATED",
      source: "system",
      requiredAgents: normalizedTeam
        .filter((agent) => agent.required)
        .map((agent) => ({ agentId: agent.agentId, state: agentState(this.#agent(agent.agentId)) })),
    });
    if (missionState(this.#mission) !== "active") throw new Error("mission model rejected activation");
    await this.#commit();
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
    await this.#commit();

    for (const actor of this.#agents.values()) {
      if (agentState(actor) !== "active") continue;
      const result = await this.#dependencies.processPort.send(actor.getSnapshot().context.agentId, content);
      this.#appendTechnicalActivity(actor.getSnapshot().context.agentId, result.activity);
      const signal = {
        ...result.signal,
        messageId: `agent:${actor.getSnapshot().context.agentId}:${++this.#messageSequence}`,
      };
      actor.send({ type: "AGENT_SIGNAL_RECORDED", source: "ai", signal });
      this.#mission.send({
        type: "AGENT_SIGNAL_RECORDED",
        source: "ai",
        agentId: actor.getSnapshot().context.agentId,
        signal,
      });
      await this.#commit();
    }
    return this.projection();
  }

  public async pause(): Promise<WorkspaceProjection> {
    this.#requireCommand("pause");
    this.#mission.send({ type: "MISSION_PAUSE_REQUESTED", source: "human", ownerId: this.#dependencies.ownerId });
    if (missionState(this.#mission) !== "pausing") throw new Error("mission model rejected pause");
    await this.#commit();
    for (const actor of this.#agents.values()) await this.#interruptAgent(actor);
    this.#mission.send({
      type: "MISSION_PAUSE_QUIESCENCE_EVALUATED",
      source: "system",
      agentStates: [...this.#agents.values()].map(agentState),
      openStartIntents: 0,
    });
    if (missionState(this.#mission) !== "paused") throw new Error("mission model rejected pause quiescence");
    await this.#commit();
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
    }
    await this.#commit();
    for (const actor of this.#agents.values()) {
      if (agentState(actor) === "starting") await this.#startAuthorizedAgent(actor);
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
    await this.#commit();
    return this.projection();
  }

  public async cancel(): Promise<WorkspaceProjection> {
    this.#requireCommand("cancel");
    this.#mission.send({ type: "MISSION_CANCEL_REQUESTED", source: "human", ownerId: this.#dependencies.ownerId });
    if (missionState(this.#mission) === "cancelled") {
      await this.#commit();
      return this.projection();
    }
    if (missionState(this.#mission) !== "cancelling") throw new Error("mission model rejected cancellation");
    await this.#commit();
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
    await this.#commit();
    return this.projection();
  }

  public async recoverAfterRestart(recoveredAt: string, persist = true): Promise<WorkspaceProjection> {
    const previousState = missionState(this.#mission);
    if (
      previousState === "draft" ||
      previousState === "completed" ||
      previousState === "cancelled" ||
      previousState === "failed"
    ) {
      return this.projection();
    }
    const disposition =
      previousState === "cancelling"
        ? ("terminal_cancellation" as const)
        : previousState === "failing"
          ? ("terminal_failure" as const)
          : ("restartable_interruption" as const);
    for (const actor of this.#agents.values()) {
      const state = agentState(actor);
      if (state === "completed" || state === "cancelled" || state === "failed") continue;
      actor.send({
        type: "WORKSPACE_RESTART_RECOVERED",
        source: "system",
        disposition,
        recoveredAt,
        processAbsenceVerified: true,
      });
    }
    this.#mission.send({
      type: "WORKSPACE_RESTART_RECOVERED",
      source: "system",
      disposition,
      previousState,
      recoveredAt,
      agentStates: [...this.#agents.values()].map(agentState),
      liveProcessCount: 0,
    });
    const expectedState =
      disposition === "restartable_interruption"
        ? "paused"
        : disposition === "terminal_cancellation"
          ? "cancelled"
          : "failed";
    if (missionState(this.#mission) !== expectedState) throw new Error("mission model rejected restart recovery");
    if (persist) await this.#commit();
    return this.projection();
  }

  public async persistCurrentState(): Promise<void> {
    await this.#commit();
  }

  public async createTemplate(command: CreateTeamTemplateCommand): Promise<readonly TeamTemplate[]> {
    if (!this.#validTemplateIdentity(command.templateId, command.name, command.agents)) {
      throw new Error("team template is invalid");
    }
    if (this.#templates.some((template) => template.templateId === command.templateId)) {
      throw new Error("team template id already exists");
    }
    this.#templates.push({
      templateId: command.templateId,
      revision: 1,
      name: command.name.trim(),
      origin: "user",
      agents: structuredClone(command.agents),
    });
    await this.#commit();
    return this.templates();
  }

  public async duplicateTemplate(command: DuplicateTeamTemplateCommand): Promise<readonly TeamTemplate[]> {
    const source = this.#templates.find(
      (template) => template.templateId === command.sourceTemplateId && template.revision === command.sourceRevision,
    );
    if (!source) throw new Error("source team template revision does not exist");
    if (this.#templates.some((template) => template.templateId === command.templateId)) {
      throw new Error("team template id already exists");
    }
    if (!this.#validTemplateIdentity(command.templateId, command.name, source.agents)) {
      throw new Error("team template is invalid");
    }
    this.#templates.push({
      templateId: command.templateId,
      revision: 1,
      name: command.name.trim(),
      origin: "duplicate",
      agents: structuredClone(source.agents),
      lineage: { sourceTemplateId: source.templateId, sourceRevision: source.revision },
    });
    await this.#commit();
    return this.templates();
  }

  public async saveTemplateRevision(command: SaveTeamTemplateRevisionCommand): Promise<readonly TeamTemplate[]> {
    const current = this.templates().find((template) => template.templateId === command.templateId);
    if (!current) throw new Error("team template does not exist");
    if (current.origin === "built_in") throw new Error("built-in team templates are immutable");
    if (current.revision !== command.expectedRevision) throw new Error("team template revision is stale");
    if (!this.#validTemplateIdentity(command.templateId, command.name, command.agents)) {
      throw new Error("team template is invalid");
    }
    this.#templates.push({
      templateId: current.templateId,
      revision: current.revision + 1,
      name: command.name.trim(),
      origin: current.origin,
      agents: structuredClone(command.agents),
      ...(current.lineage ? { lineage: structuredClone(current.lineage) } : {}),
    });
    await this.#commit();
    return this.templates();
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

  async #startAuthorizedAgent(actor: LocalAgentActor): Promise<void> {
    const id = actor.getSnapshot().context.agentId;
    const launchToken = actor.getSnapshot().context.launchToken;
    if (agentState(actor) !== "starting" || !launchToken) throw new Error(`agent ${id} has no committed start intent`);
    const started = await this.#dependencies.processPort.start(id);
    actor.send({ type: "PROCESS_STARTED", source: "tool", launchToken, processId: started.processId });
    if (agentState(actor) !== "active") throw new Error(`agent ${id} rejected process ack`);
    try {
      await this.#commit();
    } catch (error) {
      await this.#dependencies.processPort.stop(id);
      throw error;
    }
  }

  async #interruptAgent(actor: LocalAgentActor): Promise<void> {
    const id = actor.getSnapshot().context.agentId;
    actor.send({ type: "AGENT_INTERRUPT_REQUESTED", source: "system", reason: "mission-paused" });
    actor.send({ type: "DESCENDANTS_QUIESCENT", source: "system", descendantStates: [], openLaunchIntents: 0 });
    await this.#commit();
    const outcome = await this.#dependencies.processPort.stop(id);
    actor.send({
      type: outcome === "stopped" ? "PROCESS_STOPPED" : "LOCAL_PROCESS_ABSENT",
      source: "tool",
      stopToken: `stop:${id}`,
    });
    if (agentState(actor) !== "interrupted") throw new Error(`agent ${id} rejected restartable stop`);
    await this.#commit();
  }

  async #cancelAgent(actor: LocalAgentActor): Promise<void> {
    const id = actor.getSnapshot().context.agentId;
    const state = agentState(actor);
    if (state === "completed" || state === "cancelled" || state === "failed") return;
    actor.send({ type: "AGENT_CANCEL_REQUESTED", source: "system", reason: "mission-cancelled" });
    actor.send({ type: "DESCENDANTS_QUIESCENT", source: "system", descendantStates: [], openLaunchIntents: 0 });
    await this.#commit();
    const outcome = await this.#dependencies.processPort.stop(id);
    actor.send({
      type: outcome === "stopped" ? "PROCESS_STOPPED" : "LOCAL_PROCESS_ABSENT",
      source: "tool",
      stopToken: `stop:${id}`,
    });
    if (agentState(actor) !== "cancelled") throw new Error(`agent ${id} rejected terminal stop`);
    await this.#commit();
  }

  #appendTechnicalActivity(agentId: string, entry: AgentActivityEntry): void {
    const entries = this.#technicalActivity.get(agentId) ?? [];
    this.#technicalActivity.set(agentId, [...entries, sanitizeAgentActivity(entry)]);
  }

  async #commit(): Promise<void> {
    const candidate = this.persistedState();
    try {
      await this.#dependencies.persistence?.save(candidate);
      this.#lastDurableState = candidate;
    } catch (error) {
      this.#restore(this.#lastDurableState);
      throw error;
    }
  }

  #restore(state: LocalWorkspacePersistedState): void {
    this.#mission.stop();
    for (const actor of this.#agents.values()) actor.stop();
    this.#agents.clear();
    this.#technicalActivity.clear();
    this.#mission = createLocalMissionActor(
      { missionId: this.#dependencies.missionId, ownerId: this.#dependencies.ownerId },
      state.missionSnapshot,
    );
    for (const record of state.agents) {
      this.#agents.set(
        record.agentId,
        createLocalAgentActor(this.#agentInputFromSnapshot(record.snapshot), record.snapshot),
      );
    }
    for (const record of state.technicalActivity) {
      this.#technicalActivity.set(record.agentId, record.entries.map(sanitizeAgentActivity));
    }
    this.#templates.splice(
      0,
      this.#templates.length,
      ...(this.#dependencies.builtInTemplates ?? []),
      ...state.userTemplateRevisions.map((template) => structuredClone(template)),
    );
    this.#lastAutonomyContract = state.lastAutonomyContract ? structuredClone(state.lastAutonomyContract) : null;
    this.#messageSequence = state.messageSequence;
  }

  #agentInputFromSnapshot(snapshot: Snapshot<unknown>): LocalAgentMachineInput {
    if (typeof snapshot !== "object" || snapshot === null || !("context" in snapshot)) {
      throw new Error("persisted agent snapshot is malformed");
    }
    const context = snapshot.context as Partial<LocalAgentContext>;
    if (
      typeof context.agentId !== "string" ||
      typeof context.missionId !== "string" ||
      context.missionId !== this.#dependencies.missionId ||
      typeof context.ownerId !== "string" ||
      typeof context.role !== "string" ||
      !Array.isArray(context.capabilities) ||
      !Array.isArray(context.effectivePermissions) ||
      !context.retryLimits ||
      typeof context.humanRetryAttempt !== "number"
    ) {
      throw new Error("persisted agent snapshot context is invalid");
    }
    return {
      agentId: context.agentId,
      missionId: context.missionId,
      ownerId: context.ownerId,
      role: context.role,
      parentAgentId: context.parentAgentId ?? null,
      capabilities: context.capabilities,
      effectivePermissions: context.effectivePermissions,
      retryLimits: context.retryLimits,
      humanRetryAttempt: context.humanRetryAttempt,
    };
  }

  #validTemplateIdentity(templateId: string, name: string, agents: readonly MissionTemplateAgent[]): boolean {
    const ids = agents.map((agent) => agent.agentId);
    return (
      templateId.trim().length > 0 &&
      name.trim().length > 0 &&
      agents.length > 0 &&
      agents.some((agent) => agent.required) &&
      new Set(ids).size === ids.length &&
      agents.every(
        (agent) => agent.agentId.trim().length > 0 && agent.role.trim().length > 0 && agent.capabilities.length > 0,
      )
    );
  }
}
