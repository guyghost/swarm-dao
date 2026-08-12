import { type ActorRefFrom, assign, createActor, type Snapshot, setup } from "xstate";
import {
  appendUnique,
  isMissionShared,
  isNonEmpty,
  isValidTemplateSnapshot,
  type LocalAgentState,
  type MissionMessage,
  type MissionState,
  type MissionTemplateSnapshot,
  type WorkspaceEffectIntent,
  type WorkspaceEventSource,
} from "./local-workspace.types.js";

export type {
  AutonomyContract,
  MissionMessage,
  MissionState,
  MissionTemplateSnapshot,
} from "./local-workspace.types.js";

export type MissionCommand = "launch" | "send_message" | "pause" | "resume" | "cancel";

export type AgentSignal =
  | Readonly<{ kind: "shared_message"; messageId: string; content: string; createdAt: string }>
  | Readonly<{ kind: "human_input_required"; requestId: string; prompt: string; createdAt: string }>
  | Readonly<{ kind: "subagent_requested"; requestId: string; requestedRole: string; createdAt: string }>;

export interface LocalMissionContext {
  missionId: string;
  ownerId: string;
  templateSnapshot: MissionTemplateSnapshot | null;
  messages: readonly MissionMessage[];
  blockers: readonly string[];
  interventionOrigin: "pending" | "active" | null;
  effects: readonly WorkspaceEffectIntent[];
  recovery: Readonly<{
    required: boolean;
    previousState: MissionState;
    recoveredAt: string;
  }> | null;
}

export interface LocalMissionMachineInput {
  missionId: string;
  ownerId: string;
}

export type LocalMissionEvent =
  | Readonly<{
      type: "MISSION_LAUNCH_REQUESTED";
      source: WorkspaceEventSource;
      ownerId: string;
      snapshot: MissionTemplateSnapshot;
    }>
  | Readonly<{
      type: "MISSION_ACTIVATION_EVALUATED";
      source: WorkspaceEventSource;
      requiredAgents: readonly { agentId: string; state: LocalAgentState }[];
    }>
  | Readonly<{ type: "MISSION_PAUSE_REQUESTED"; source: WorkspaceEventSource; ownerId: string }>
  | Readonly<{
      type: "MISSION_PAUSE_QUIESCENCE_EVALUATED";
      source: WorkspaceEventSource;
      agentStates: readonly LocalAgentState[];
      openStartIntents: number;
    }>
  | Readonly<{ type: "MISSION_RESUME_REQUESTED"; source: WorkspaceEventSource; ownerId: string }>
  | Readonly<{
      type: "AGENT_SIGNAL_RECORDED";
      source: WorkspaceEventSource;
      agentId: string;
      signal: AgentSignal;
    }>
  | Readonly<{
      type: "MISSION_HUMAN_INTERVENTION_REQUIRED";
      source: WorkspaceEventSource;
      blockerId: string;
      origin: "pending" | "active";
    }>
  | Readonly<{
      type: "MISSION_INTERVENTION_EVALUATED";
      source: WorkspaceEventSource;
      resolvedBlockerIds: readonly string[];
    }>
  | Readonly<{
      type: "MISSION_COMPLETION_EVALUATED";
      source: WorkspaceEventSource;
      allWorkTerminal: boolean;
      openSubagentRequests: number;
      unresolvedBlockers: number;
      completionEvidence: string;
    }>
  | Readonly<{ type: "MISSION_CANCEL_REQUESTED"; source: WorkspaceEventSource; ownerId: string }>
  | Readonly<{ type: "MISSION_FAILURE_RECORDED"; source: WorkspaceEventSource; errorCode: string }>
  | Readonly<{
      type: "MISSION_QUIESCENCE_EVALUATED";
      source: WorkspaceEventSource;
      allAgentsQuiescent: boolean;
      openSubagentRequests: number;
      liveProcessCount: number;
    }>
  | Readonly<{
      type: "HUMAN_MESSAGE_SUBMITTED";
      source: WorkspaceEventSource;
      ownerId: string;
      message: MissionMessage;
    }>
  | Readonly<{
      type: "WORKSPACE_RESTART_RECOVERED";
      source: WorkspaceEventSource;
      disposition: "restartable_interruption" | "terminal_cancellation" | "terminal_failure";
      previousState: MissionState;
      recoveredAt: string;
      agentStates: readonly LocalAgentState[];
      liveProcessCount: number;
    }>;

const ownerEvent = (context: LocalMissionContext, event: LocalMissionEvent): boolean =>
  "ownerId" in event && event.source === "human" && event.ownerId === context.ownerId;

const addEffect = (context: LocalMissionContext, kind: string, suffix: string): readonly WorkspaceEffectIntent[] => [
  ...context.effects,
  {
    kind,
    aggregateId: context.missionId,
    idempotencyKey: `${context.missionId}:${kind}:${suffix}`,
  },
];

const terminalAgentStates = new Set<LocalAgentState>(["completed", "cancelled", "failed", "interrupted"]);

const missionSetup = setup({
  types: {
    context: {} as LocalMissionContext,
    input: {} as LocalMissionMachineInput,
    events: {} as LocalMissionEvent,
  },
  guards: {
    ownerValidSnapshot: ({ context, event }) =>
      event.type === "MISSION_LAUNCH_REQUESTED" &&
      ownerEvent(context, event) &&
      isValidTemplateSnapshot(event.snapshot, context.missionId),
    allRequiredAgentsActive: ({ event }) =>
      event.type === "MISSION_ACTIVATION_EVALUATED" &&
      event.source === "system" &&
      event.requiredAgents.length > 0 &&
      event.requiredAgents.every((agent) => agent.state === "active"),
    activationNeedsHuman: ({ event }) =>
      event.type === "MISSION_ACTIVATION_EVALUATED" &&
      event.source === "system" &&
      event.requiredAgents.some((agent) => agent.state === "failed" || agent.state === "waiting_for_human"),
    systemEvent: ({ event }) => event.source === "system",
    owner: ({ context, event }) => ownerEvent(context, event),
    ownerNoBlockers: ({ context, event }) => ownerEvent(context, event) && context.blockers.length === 0,
    sharedHumanMessage: ({ context, event }) =>
      event.type === "HUMAN_MESSAGE_SUBMITTED" &&
      ownerEvent(context, event) &&
      isMissionShared(event.message.visibility) &&
      event.message.author.kind === "human" &&
      event.message.author.id === context.ownerId &&
      isNonEmpty(event.message.content),
    sharedAgentMessage: ({ event }) =>
      event.type === "AGENT_SIGNAL_RECORDED" &&
      event.source === "ai" &&
      event.signal.kind === "shared_message" &&
      isNonEmpty(event.agentId) &&
      isNonEmpty(event.signal.content),
    agentHumanInputSignal: ({ event }) =>
      event.type === "AGENT_SIGNAL_RECORDED" &&
      event.source === "ai" &&
      event.signal.kind === "human_input_required" &&
      isNonEmpty(event.signal.requestId),
    structuredBlocker: ({ event }) =>
      event.type === "MISSION_HUMAN_INTERVENTION_REQUIRED" && event.source === "system" && isNonEmpty(event.blockerId),
    allBlockersResolvedFromActive: ({ context, event }) =>
      event.type === "MISSION_INTERVENTION_EVALUATED" &&
      event.source === "system" &&
      context.interventionOrigin === "active" &&
      context.blockers.every((blocker) => event.resolvedBlockerIds.includes(blocker)),
    allBlockersResolvedFromPending: ({ context, event }) =>
      event.type === "MISSION_INTERVENTION_EVALUATED" &&
      event.source === "system" &&
      context.interventionOrigin === "pending" &&
      context.blockers.every((blocker) => event.resolvedBlockerIds.includes(blocker)),
    pauseQuiescent: ({ event }) =>
      event.type === "MISSION_PAUSE_QUIESCENCE_EVALUATED" &&
      event.source === "system" &&
      event.openStartIntents === 0 &&
      event.agentStates.every((state) => terminalAgentStates.has(state)),
    completionProven: ({ event }) =>
      event.type === "MISSION_COMPLETION_EVALUATED" &&
      event.source === "system" &&
      event.allWorkTerminal &&
      event.openSubagentRequests === 0 &&
      event.unresolvedBlockers === 0 &&
      isNonEmpty(event.completionEvidence),
    fatalFailure: ({ event }) =>
      event.type === "MISSION_FAILURE_RECORDED" &&
      (event.source === "system" || event.source === "tool") &&
      isNonEmpty(event.errorCode),
    quiescent: ({ event }) =>
      event.type === "MISSION_QUIESCENCE_EVALUATED" &&
      event.source === "system" &&
      event.allAgentsQuiescent &&
      event.openSubagentRequests === 0 &&
      event.liveProcessCount === 0,
    restartableRecovery: ({ event }) =>
      event.type === "WORKSPACE_RESTART_RECOVERED" &&
      event.source === "system" &&
      event.disposition === "restartable_interruption" &&
      isNonEmpty(event.recoveredAt) &&
      event.liveProcessCount === 0 &&
      event.agentStates.every((state) => state === "interrupted" || terminalAgentStates.has(state)),
    cancellationRecovery: ({ event }) =>
      event.type === "WORKSPACE_RESTART_RECOVERED" &&
      event.source === "system" &&
      event.disposition === "terminal_cancellation" &&
      isNonEmpty(event.recoveredAt) &&
      event.liveProcessCount === 0 &&
      event.agentStates.every((state) => state === "completed" || state === "cancelled" || state === "failed"),
    failureRecovery: ({ event }) =>
      event.type === "WORKSPACE_RESTART_RECOVERED" &&
      event.source === "system" &&
      event.disposition === "terminal_failure" &&
      isNonEmpty(event.recoveredAt) &&
      event.liveProcessCount === 0 &&
      event.agentStates.every((state) => state === "completed" || state === "cancelled" || state === "failed"),
  },
  actions: {
    sealSnapshot: assign(({ context, event }) => {
      if (event.type !== "MISSION_LAUNCH_REQUESTED") return {};
      return {
        templateSnapshot: structuredClone(event.snapshot),
        effects: addEffect(context, "start_top_level_agents", event.snapshot.contentHash),
      };
    }),
    appendActivatedNotice: assign(({ context }) => {
      const createdAt = context.templateSnapshot?.sealedAt ?? "injected-time-missing";
      return {
        messages: appendUnique(context.messages, {
          messageId: `mission-activated:${context.missionId}`,
          missionId: context.missionId,
          author: { kind: "system", id: "mission-model", displayName: "Workspace" },
          visibility: { kind: "mission_shared", participantIds: [] },
          kind: "system_notice",
          content: "Mission activated.",
          createdAt,
        }),
      };
    }),
    appendHumanMessage: assign(({ context, event }) =>
      event.type === "HUMAN_MESSAGE_SUBMITTED"
        ? { messages: appendUnique(context.messages, { ...event.message, missionId: context.missionId }) }
        : {},
    ),
    appendAgentMessage: assign(({ context, event }) => {
      if (event.type !== "AGENT_SIGNAL_RECORDED" || event.signal.kind !== "shared_message") return {};
      return {
        messages: appendUnique(context.messages, {
          messageId: event.signal.messageId,
          missionId: context.missionId,
          author: { kind: "agent", id: event.agentId, displayName: event.agentId },
          visibility: { kind: "mission_shared", participantIds: [] },
          kind: "conversation",
          content: event.signal.content,
          createdAt: event.signal.createdAt,
        }),
      };
    }),
    openAgentBlocker: assign(({ context, event }) => {
      if (event.type !== "AGENT_SIGNAL_RECORDED" || event.signal.kind !== "human_input_required") return {};
      return {
        blockers: context.blockers.includes(event.signal.requestId)
          ? context.blockers
          : [...context.blockers, event.signal.requestId],
        interventionOrigin: "active" as const,
      };
    }),
    openStructuredBlocker: assign(({ context, event }) => {
      if (event.type !== "MISSION_HUMAN_INTERVENTION_REQUIRED") return {};
      return {
        blockers: context.blockers.includes(event.blockerId)
          ? context.blockers
          : [...context.blockers, event.blockerId],
        interventionOrigin: event.origin,
      };
    }),
    resolveBlockers: assign(({ context, event }) =>
      event.type === "MISSION_INTERVENTION_EVALUATED"
        ? {
            blockers: context.blockers.filter((blocker) => !event.resolvedBlockerIds.includes(blocker)),
            interventionOrigin: null,
          }
        : {},
    ),
    requestPause: assign(({ context }) => ({
      effects: addEffect(context, "interrupt_agents_restartably", "pause"),
    })),
    requestResume: assign(({ context }) => ({
      effects: addEffect(context, "restart_interrupted_agents", "resume"),
      recovery: null,
    })),
    requestCancel: assign(({ context }) => ({
      effects: addEffect(context, "cancel_agents_descendants_first", "cancel"),
    })),
    requestFailureCleanup: assign(({ context, event }) => ({
      effects: addEffect(
        context,
        "cancel_agents_descendants_first",
        event.type === "MISSION_FAILURE_RECORDED" ? event.errorCode : "failure",
      ),
    })),
    recordRestartRecovery: assign(({ context, event }) => {
      if (event.type !== "WORKSPACE_RESTART_RECOVERED") return {};
      return {
        recovery: {
          required: event.disposition === "restartable_interruption",
          previousState: event.previousState,
          recoveredAt: event.recoveredAt,
        },
        effects: [],
        messages: appendUnique(context.messages, {
          messageId: `mission-recovered:${context.missionId}:${event.recoveredAt}`,
          missionId: context.missionId,
          author: { kind: "system", id: "mission-model", displayName: "Workspace" },
          visibility: { kind: "mission_shared", participantIds: [] },
          kind: "system_notice",
          content:
            event.disposition === "restartable_interruption"
              ? "Mission paused after app restart. Local agents were not restarted."
              : event.disposition === "terminal_cancellation"
                ? "Mission cancellation completed during restart recovery."
                : "Mission failure cleanup completed during restart recovery.",
          createdAt: event.recoveredAt,
        }),
      };
    }),
  },
});

const sharedMessageTransitions = {
  HUMAN_MESSAGE_SUBMITTED: { guard: "sharedHumanMessage", actions: "appendHumanMessage" },
} as const;

const cancelTransition = {
  MISSION_CANCEL_REQUESTED: { guard: "owner", target: "cancelling", actions: "requestCancel" },
} as const;

const failureTransition = {
  MISSION_FAILURE_RECORDED: { guard: "fatalFailure", target: "failing", actions: "requestFailureCleanup" },
} as const;

export const localMissionMachine = missionSetup.createMachine({
  id: "localMission",
  initial: "draft",
  context: ({ input }) => ({
    missionId: input.missionId,
    ownerId: input.ownerId,
    templateSnapshot: null,
    messages: [],
    blockers: [],
    interventionOrigin: null,
    effects: [],
    recovery: null,
  }),
  states: {
    draft: {
      on: {
        MISSION_LAUNCH_REQUESTED: { guard: "ownerValidSnapshot", target: "pending", actions: "sealSnapshot" },
        ...sharedMessageTransitions,
        MISSION_CANCEL_REQUESTED: { guard: "owner", target: "cancelled" },
      },
    },
    pending: {
      on: {
        WORKSPACE_RESTART_RECOVERED: {
          guard: "restartableRecovery",
          target: "paused",
          actions: "recordRestartRecovery",
        },
        MISSION_ACTIVATION_EVALUATED: [
          { guard: "allRequiredAgentsActive", target: "active", actions: "appendActivatedNotice" },
          {
            guard: "activationNeedsHuman",
            target: "human_intervention_required",
            actions: assign({ interventionOrigin: "pending" }),
          },
        ],
        MISSION_HUMAN_INTERVENTION_REQUIRED: {
          guard: "structuredBlocker",
          target: "human_intervention_required",
          actions: "openStructuredBlocker",
        },
        ...sharedMessageTransitions,
        ...cancelTransition,
        ...failureTransition,
      },
    },
    active: {
      on: {
        WORKSPACE_RESTART_RECOVERED: {
          guard: "restartableRecovery",
          target: "paused",
          actions: "recordRestartRecovery",
        },
        AGENT_SIGNAL_RECORDED: [
          { guard: "agentHumanInputSignal", target: "human_intervention_required", actions: "openAgentBlocker" },
          { guard: "sharedAgentMessage", actions: "appendAgentMessage" },
        ],
        MISSION_HUMAN_INTERVENTION_REQUIRED: {
          guard: "structuredBlocker",
          target: "human_intervention_required",
          actions: "openStructuredBlocker",
        },
        MISSION_PAUSE_REQUESTED: { guard: "owner", target: "pausing", actions: "requestPause" },
        MISSION_COMPLETION_EVALUATED: { guard: "completionProven", target: "completed" },
        ...sharedMessageTransitions,
        ...cancelTransition,
        ...failureTransition,
      },
    },
    pausing: {
      on: {
        WORKSPACE_RESTART_RECOVERED: {
          guard: "restartableRecovery",
          target: "paused",
          actions: "recordRestartRecovery",
        },
        MISSION_PAUSE_QUIESCENCE_EVALUATED: { guard: "pauseQuiescent", target: "paused" },
        ...sharedMessageTransitions,
        ...cancelTransition,
        ...failureTransition,
      },
    },
    paused: {
      on: {
        WORKSPACE_RESTART_RECOVERED: { guard: "restartableRecovery", actions: "recordRestartRecovery" },
        MISSION_RESUME_REQUESTED: { guard: "ownerNoBlockers", target: "pending", actions: "requestResume" },
        ...sharedMessageTransitions,
        ...cancelTransition,
        ...failureTransition,
      },
    },
    human_intervention_required: {
      on: {
        WORKSPACE_RESTART_RECOVERED: {
          guard: "restartableRecovery",
          target: "paused",
          actions: "recordRestartRecovery",
        },
        MISSION_INTERVENTION_EVALUATED: [
          { guard: "allBlockersResolvedFromActive", target: "active", actions: "resolveBlockers" },
          { guard: "allBlockersResolvedFromPending", target: "pending", actions: "resolveBlockers" },
        ],
        ...sharedMessageTransitions,
        ...cancelTransition,
        ...failureTransition,
      },
    },
    cancelling: {
      on: {
        WORKSPACE_RESTART_RECOVERED: {
          guard: "cancellationRecovery",
          target: "cancelled",
          actions: "recordRestartRecovery",
        },
        MISSION_QUIESCENCE_EVALUATED: { guard: "quiescent", target: "cancelled" },
        ...failureTransition,
      },
    },
    failing: {
      on: {
        WORKSPACE_RESTART_RECOVERED: {
          guard: "failureRecovery",
          target: "failed",
          actions: "recordRestartRecovery",
        },
        MISSION_QUIESCENCE_EVALUATED: { guard: "quiescent", target: "failed" },
      },
    },
    completed: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

export type LocalMissionActor = ActorRefFrom<typeof localMissionMachine>;

export const createLocalMissionActor = (
  input: LocalMissionMachineInput,
  snapshot?: Snapshot<unknown>,
): LocalMissionActor => {
  const actor = createActor(localMissionMachine, { input, snapshot });
  actor.start();
  return actor;
};

export const missionAvailableCommands = (state: unknown): readonly MissionCommand[] => {
  switch (String(state) as MissionState) {
    case "draft":
      return ["launch", "send_message", "cancel"];
    case "active":
      return ["send_message", "pause", "cancel"];
    case "paused":
      return ["send_message", "resume", "cancel"];
    case "pending":
    case "pausing":
    case "human_intervention_required":
      return ["send_message", "cancel"];
    default:
      return [];
  }
};
