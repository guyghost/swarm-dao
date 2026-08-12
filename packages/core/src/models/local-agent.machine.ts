import { type ActorRefFrom, assign, createActor, setup } from "xstate";
import {
  type AgentActivityEntry,
  isNonEmpty,
  type LocalAgentState,
  type RetryLimits,
  type WorkspaceEffectIntent,
  type WorkspaceEventSource,
} from "./local-workspace.types.js";

export interface LocalAgentContext {
  agentId: string;
  missionId: string;
  ownerId: string;
  role: string;
  parentAgentId: string | null;
  capabilities: readonly string[];
  effectivePermissions: readonly string[];
  retryLimits: RetryLimits;
  humanRetryAttempt: number;
  startAttempt: number;
  runtimeAttempt: number;
  stopAttempt: number;
  launchToken: string | null;
  processId: number | null;
  stopReason: "restartable" | "terminal" | null;
  descendantsQuiescent: boolean;
  pendingHumanRetry: Readonly<{ operation: "start" | "runtime"; attempt: number }> | null;
  activity: readonly AgentActivityEntry[];
  effects: readonly WorkspaceEffectIntent[];
  errorCode: string | null;
}

export interface LocalAgentMachineInput {
  agentId: string;
  missionId: string;
  ownerId: string;
  role: string;
  parentAgentId: string | null;
  capabilities: readonly string[];
  effectivePermissions: readonly string[];
  retryLimits: RetryLimits;
  humanRetryAttempt: number;
}

export type LocalAgentEvent =
  | Readonly<{
      type: "AGENT_START_AUTHORIZED";
      source: WorkspaceEventSource;
      launchToken: string;
      reservationId: string;
    }>
  | Readonly<{ type: "PROCESS_STARTED"; source: WorkspaceEventSource; launchToken: string; processId: number }>
  | Readonly<{ type: "PROCESS_START_FAILED"; source: WorkspaceEventSource; errorCode: string }>
  | Readonly<{
      type: "AGENT_SIGNAL_RECORDED";
      source: WorkspaceEventSource;
      signal: Readonly<
        | { kind: "shared_message"; content: string }
        | { kind: "subagent_requested"; requestId: string }
        | { kind: "human_input_required"; requestId: string }
      >;
    }>
  | Readonly<{ type: "HUMAN_RESPONSE_RECORDED"; source: WorkspaceEventSource; ownerId: string; requestId: string }>
  | Readonly<{
      type: "PROCESS_EXITED";
      source: WorkspaceEventSource;
      exitCode: number;
      errorCode?: string;
      completionEvidence?: string;
    }>
  | Readonly<{ type: "AGENT_INTERRUPT_REQUESTED"; source: WorkspaceEventSource; ownerId?: string; reason: string }>
  | Readonly<{ type: "AGENT_CANCEL_REQUESTED"; source: WorkspaceEventSource; reason: string }>
  | Readonly<{
      type: "DESCENDANTS_QUIESCENT";
      source: WorkspaceEventSource;
      descendantStates: readonly LocalAgentState[];
      openLaunchIntents: number;
    }>
  | Readonly<{ type: "PROCESS_STOPPED"; source: WorkspaceEventSource; stopToken: string }>
  | Readonly<{ type: "LOCAL_PROCESS_ABSENT"; source: WorkspaceEventSource; stopToken: string }>
  | Readonly<{ type: "PROCESS_STOP_FAILED"; source: WorkspaceEventSource; errorCode: string }>
  | Readonly<{ type: "STOP_RETRY_DUE"; source: WorkspaceEventSource; attempt: number }>
  | Readonly<{ type: "AGENT_RESTART_AUTHORIZED"; source: WorkspaceEventSource; launchToken: string }>
  | Readonly<{ type: "AGENT_RETRY_DUE"; source: WorkspaceEventSource; attempt: number }>
  | Readonly<{
      type: "AGENT_RETRY_AUTHORIZED";
      source: WorkspaceEventSource;
      ownerId: string;
      operation: "start" | "runtime";
      attempt: number;
    }>;

const retryableErrorCodes = new Set(["process-temporary", "resource-temporary", "worker-unavailable"]);
const descendantTerminalStates = new Set<LocalAgentState>(["completed", "cancelled", "failed", "interrupted"]);

const appendActivity = (context: LocalAgentContext, kind: string, detail: string): readonly AgentActivityEntry[] => [
  ...context.activity,
  { kind, detail },
];

const appendEffect = (context: LocalAgentContext, kind: string, attempt: number): readonly WorkspaceEffectIntent[] => [
  ...context.effects,
  {
    kind,
    aggregateId: context.agentId,
    idempotencyKey: `${context.missionId}:${context.agentId}:${kind}:${attempt}`,
  },
];

const nextAttempt = (context: LocalAgentContext, operation: "start" | "runtime"): number =>
  (operation === "start" ? context.startAttempt : context.runtimeAttempt) + 1;

const retryLimit = (context: LocalAgentContext, operation: "start" | "runtime"): number =>
  operation === "start" ? context.retryLimits.start : context.retryLimits.runtime;

const eventError = (event: LocalAgentEvent): string | null => {
  if (event.type === "PROCESS_START_FAILED" || event.type === "PROCESS_STOP_FAILED") return event.errorCode;
  if (event.type === "PROCESS_EXITED") return event.errorCode ?? null;
  return null;
};

const canAutomaticallyRetry = (
  context: LocalAgentContext,
  event: LocalAgentEvent,
  operation: "start" | "runtime",
): boolean => {
  const error = eventError(event);
  const attempt = nextAttempt(context, operation);
  return (
    event.source === "tool" &&
    error !== null &&
    retryableErrorCodes.has(error) &&
    attempt < context.humanRetryAttempt &&
    attempt <= retryLimit(context, operation)
  );
};

const requiresHumanRetry = (
  context: LocalAgentContext,
  event: LocalAgentEvent,
  operation: "start" | "runtime",
): boolean => {
  const error = eventError(event);
  const attempt = nextAttempt(context, operation);
  return (
    event.source === "tool" &&
    error !== null &&
    retryableErrorCodes.has(error) &&
    attempt >= context.humanRetryAttempt &&
    attempt <= retryLimit(context, operation)
  );
};

const cannotRetry = (context: LocalAgentContext, event: LocalAgentEvent, operation: "start" | "runtime"): boolean => {
  const error = eventError(event);
  return (
    event.source === "tool" &&
    (error === null ||
      !retryableErrorCodes.has(error) ||
      nextAttempt(context, operation) > retryLimit(context, operation))
  );
};

const agentSetup = setup({
  types: {
    context: {} as LocalAgentContext,
    input: {} as LocalAgentMachineInput,
    events: {} as LocalAgentEvent,
  },
  guards: {
    systemStartAuthorization: ({ event }) =>
      event.type === "AGENT_START_AUTHORIZED" &&
      event.source === "system" &&
      isNonEmpty(event.launchToken) &&
      isNonEmpty(event.reservationId),
    matchingProcessStart: ({ context, event }) =>
      event.type === "PROCESS_STARTED" &&
      event.source === "tool" &&
      event.launchToken === context.launchToken &&
      event.processId > 0,
    automaticStartRetry: ({ context, event }) => canAutomaticallyRetry(context, event, "start"),
    humanStartRetry: ({ context, event }) => requiresHumanRetry(context, event, "start"),
    startCannotRetry: ({ context, event }) => cannotRetry(context, event, "start"),
    automaticRuntimeRetry: ({ context, event }) => canAutomaticallyRetry(context, event, "runtime"),
    humanRuntimeRetry: ({ context, event }) => requiresHumanRetry(context, event, "runtime"),
    runtimeCannotRetry: ({ context, event }) => cannotRetry(context, event, "runtime"),
    automaticRetryDue: ({ context, event }) =>
      event.type === "AGENT_RETRY_DUE" &&
      event.source === "system" &&
      context.pendingHumanRetry === null &&
      event.attempt === Math.max(context.startAttempt, context.runtimeAttempt),
    exactHumanRetry: ({ context, event }) =>
      event.type === "AGENT_RETRY_AUTHORIZED" &&
      event.source === "human" &&
      event.ownerId === context.ownerId &&
      context.pendingHumanRetry?.operation === event.operation &&
      context.pendingHumanRetry.attempt === event.attempt,
    humanInputSignal: ({ event }) =>
      event.type === "AGENT_SIGNAL_RECORDED" &&
      event.source === "ai" &&
      event.signal.kind === "human_input_required" &&
      isNonEmpty(event.signal.requestId),
    contentSignal: ({ event }) =>
      event.type === "AGENT_SIGNAL_RECORDED" &&
      event.source === "ai" &&
      (event.signal.kind === "shared_message" || event.signal.kind === "subagent_requested"),
    matchingHumanResponse: ({ context, event }) =>
      event.type === "HUMAN_RESPONSE_RECORDED" &&
      event.source === "human" &&
      event.ownerId === context.ownerId &&
      isNonEmpty(event.requestId),
    expectedCompletion: ({ event }) =>
      event.type === "PROCESS_EXITED" &&
      event.source === "tool" &&
      event.exitCode === 0 &&
      isNonEmpty(event.completionEvidence ?? ""),
    authorizedInterrupt: ({ context, event }) =>
      event.type === "AGENT_INTERRUPT_REQUESTED" &&
      ((event.source === "human" && event.ownerId === context.ownerId) || event.source === "system"),
    terminalCancel: ({ event }) => event.type === "AGENT_CANCEL_REQUESTED" && event.source === "system",
    descendantsQuiescent: ({ event }) =>
      event.type === "DESCENDANTS_QUIESCENT" &&
      event.source === "system" &&
      event.openLaunchIntents === 0 &&
      event.descendantStates.every((state) => descendantTerminalStates.has(state)),
    matchingRestartableStop: ({ context, event }) =>
      (event.type === "PROCESS_STOPPED" || event.type === "LOCAL_PROCESS_ABSENT") &&
      event.source === "tool" &&
      event.stopToken === `stop:${context.agentId}` &&
      context.stopReason === "restartable" &&
      context.descendantsQuiescent,
    matchingTerminalStop: ({ context, event }) =>
      (event.type === "PROCESS_STOPPED" || event.type === "LOCAL_PROCESS_ABSENT") &&
      event.source === "tool" &&
      event.stopToken === `stop:${context.agentId}` &&
      context.stopReason === "terminal" &&
      context.descendantsQuiescent,
    stopRetryAvailable: ({ context, event }) =>
      event.type === "PROCESS_STOP_FAILED" &&
      event.source === "tool" &&
      retryableErrorCodes.has(event.errorCode) &&
      context.stopAttempt + 1 <= context.retryLimits.stop,
    stopRetryExhausted: ({ context, event }) =>
      event.type === "PROCESS_STOP_FAILED" &&
      event.source === "tool" &&
      (!retryableErrorCodes.has(event.errorCode) || context.stopAttempt + 1 > context.retryLimits.stop),
    matchingStopRetry: ({ context, event }) =>
      event.type === "STOP_RETRY_DUE" &&
      event.source === "system" &&
      event.attempt === context.stopAttempt &&
      context.descendantsQuiescent,
    restartAuthorization: ({ event }) =>
      event.type === "AGENT_RESTART_AUTHORIZED" &&
      (event.source === "human" || event.source === "system") &&
      isNonEmpty(event.launchToken),
    failingDescendantsQuiescent: ({ context, event }) =>
      event.type === "DESCENDANTS_QUIESCENT" &&
      event.source === "system" &&
      context.processId === null &&
      event.openLaunchIntents === 0 &&
      event.descendantStates.every((state) => descendantTerminalStates.has(state)),
  },
  actions: {
    recordStartRequest: assign(({ context, event }) => {
      if (event.type !== "AGENT_START_AUTHORIZED") return {};
      return {
        launchToken: event.launchToken,
        activity: appendActivity(context, "start_requested", event.reservationId),
        effects: appendEffect(context, "launch_local_agent", context.startAttempt),
      };
    }),
    recordProcessStarted: assign(({ context, event }) =>
      event.type === "PROCESS_STARTED"
        ? {
            processId: event.processId,
            pendingHumanRetry: null,
            activity: appendActivity(context, "process_started", String(event.processId)),
          }
        : {},
    ),
    recordAutomaticStartRetry: assign(({ context, event }) => ({
      startAttempt: context.startAttempt + 1,
      pendingHumanRetry: null,
      errorCode: eventError(event),
      activity: appendActivity(context, "automatic_retry_scheduled", eventError(event) ?? "unknown"),
    })),
    recordHumanStartRetry: assign(({ context, event }) => {
      const attempt = context.startAttempt + 1;
      return {
        startAttempt: attempt,
        pendingHumanRetry: { operation: "start" as const, attempt },
        errorCode: eventError(event),
        activity: appendActivity(context, "human_retry_required", `start:${attempt}`),
      };
    }),
    recordAutomaticRuntimeRetry: assign(({ context, event }) => ({
      processId: null,
      runtimeAttempt: context.runtimeAttempt + 1,
      pendingHumanRetry: null,
      errorCode: eventError(event),
      activity: appendActivity(context, "automatic_retry_scheduled", eventError(event) ?? "unknown"),
    })),
    recordHumanRuntimeRetry: assign(({ context, event }) => {
      const attempt = context.runtimeAttempt + 1;
      return {
        processId: null,
        runtimeAttempt: attempt,
        pendingHumanRetry: { operation: "runtime" as const, attempt },
        errorCode: eventError(event),
        activity: appendActivity(context, "human_retry_required", `runtime:${attempt}`),
      };
    }),
    recordRetryLaunch: assign(({ context }) => ({
      launchToken: `retry:${context.agentId}:${Math.max(context.startAttempt, context.runtimeAttempt)}`,
      effects: appendEffect(context, "launch_local_agent", Math.max(context.startAttempt, context.runtimeAttempt)),
      activity: appendActivity(
        context,
        "retry_authorized",
        String(Math.max(context.startAttempt, context.runtimeAttempt)),
      ),
      pendingHumanRetry: null,
    })),
    recordHumanWait: assign(({ context, event }) => ({
      activity: appendActivity(
        context,
        "human_input_required",
        event.type === "AGENT_SIGNAL_RECORDED" && event.signal.kind === "human_input_required"
          ? event.signal.requestId
          : "unknown",
      ),
    })),
    recordSignal: assign(({ context, event }) => ({
      activity: appendActivity(
        context,
        "agent_signal",
        event.type === "AGENT_SIGNAL_RECORDED" ? event.signal.kind : "unknown",
      ),
    })),
    recordHumanResponse: assign(({ context, event }) => ({
      activity: appendActivity(
        context,
        "human_response",
        event.type === "HUMAN_RESPONSE_RECORDED" ? event.requestId : "unknown",
      ),
    })),
    recordCompletion: assign(({ context, event }) => ({
      processId: null,
      activity: appendActivity(
        context,
        "completed",
        event.type === "PROCESS_EXITED" ? (event.completionEvidence ?? "") : "",
      ),
    })),
    recordFatalExit: assign(({ context, event }) => ({
      processId: null,
      errorCode: eventError(event),
      effects: appendEffect(context, "cancel_descendants", context.runtimeAttempt),
      activity: appendActivity(context, "process_failed", eventError(event) ?? "unknown"),
    })),
    recordRestartableStop: assign(({ context, event }) => ({
      stopReason: "restartable" as const,
      descendantsQuiescent: false,
      effects: appendEffect(context, "cancel_launch_and_stop_descendants", context.stopAttempt),
      activity: appendActivity(context, "stop_requested", event.type),
    })),
    recordTerminalStop: assign(({ context, event }) => ({
      stopReason: "terminal" as const,
      descendantsQuiescent: false,
      effects: appendEffect(context, "cancel_launch_and_stop_descendants", context.stopAttempt),
      activity: appendActivity(context, "stop_requested", event.type),
    })),
    recordDescendantsQuiescent: assign(({ context }) => ({
      descendantsQuiescent: true,
      effects: appendEffect(context, "stop_local_agent_or_record_absence", context.stopAttempt),
    })),
    recordStopped: assign(({ context }) => ({
      processId: null,
      activity: appendActivity(context, "process_stopped", context.stopReason ?? "unknown"),
    })),
    recordStopRetry: assign(({ context, event }) => ({
      stopAttempt: context.stopAttempt + 1,
      errorCode: eventError(event),
      activity: appendActivity(context, "stop_retry_scheduled", eventError(event) ?? "unknown"),
    })),
    requestStopRetry: assign(({ context }) => ({
      effects: appendEffect(context, "stop_local_agent_or_record_absence", context.stopAttempt),
    })),
    recordStopFailure: assign(({ context, event }) => ({
      errorCode: eventError(event),
      activity: appendActivity(context, "stop_failed", eventError(event) ?? "unknown"),
    })),
    recordRestart: assign(({ context, event }) => ({
      launchToken: event.type === "AGENT_RESTART_AUTHORIZED" ? event.launchToken : null,
      stopReason: null,
      descendantsQuiescent: false,
      effects: appendEffect(context, "launch_local_agent", context.startAttempt + context.runtimeAttempt),
      activity: appendActivity(context, "restart_authorized", "restartable"),
    })),
  },
});

const failureTransitions = [
  { guard: "automaticStartRetry", target: "retry_wait", actions: "recordAutomaticStartRetry" },
  { guard: "humanStartRetry", target: "retry_wait", actions: "recordHumanStartRetry" },
  { guard: "startCannotRetry", target: "failed", actions: "recordStopFailure" },
] as const;

const runningExitTransitions = [
  { guard: "expectedCompletion", target: "completed", actions: "recordCompletion" },
  { guard: "automaticRuntimeRetry", target: "retry_wait", actions: "recordAutomaticRuntimeRetry" },
  { guard: "humanRuntimeRetry", target: "retry_wait", actions: "recordHumanRuntimeRetry" },
  { guard: "runtimeCannotRetry", target: "failing", actions: "recordFatalExit" },
] as const;

const runningStopTransitions = {
  AGENT_INTERRUPT_REQUESTED: {
    guard: "authorizedInterrupt",
    target: "stopping",
    actions: "recordRestartableStop",
  },
  AGENT_CANCEL_REQUESTED: { guard: "terminalCancel", target: "stopping", actions: "recordTerminalStop" },
} as const;

export const localAgentMachine = agentSetup.createMachine({
  id: "localAgent",
  initial: "ready",
  context: ({ input }) => ({
    ...input,
    startAttempt: 0,
    runtimeAttempt: 0,
    stopAttempt: 0,
    launchToken: null,
    processId: null,
    stopReason: null,
    descendantsQuiescent: false,
    pendingHumanRetry: null,
    activity: [],
    effects: [],
    errorCode: null,
  }),
  states: {
    ready: {
      on: {
        AGENT_START_AUTHORIZED: {
          guard: "systemStartAuthorization",
          target: "starting",
          actions: "recordStartRequest",
        },
        ...runningStopTransitions,
      },
    },
    starting: {
      on: {
        PROCESS_STARTED: { guard: "matchingProcessStart", target: "active", actions: "recordProcessStarted" },
        PROCESS_START_FAILED: failureTransitions,
        ...runningStopTransitions,
      },
    },
    active: {
      on: {
        AGENT_SIGNAL_RECORDED: [
          { guard: "humanInputSignal", target: "waiting_for_human", actions: "recordHumanWait" },
          { guard: "contentSignal", actions: "recordSignal" },
        ],
        PROCESS_EXITED: runningExitTransitions,
        ...runningStopTransitions,
      },
    },
    waiting_for_human: {
      on: {
        HUMAN_RESPONSE_RECORDED: {
          guard: "matchingHumanResponse",
          target: "active",
          actions: "recordHumanResponse",
        },
        PROCESS_EXITED: runningExitTransitions,
        ...runningStopTransitions,
      },
    },
    retry_wait: {
      on: {
        AGENT_RETRY_DUE: { guard: "automaticRetryDue", target: "starting", actions: "recordRetryLaunch" },
        AGENT_RETRY_AUTHORIZED: { guard: "exactHumanRetry", target: "starting", actions: "recordRetryLaunch" },
        ...runningStopTransitions,
      },
    },
    interrupted: {
      on: {
        AGENT_RESTART_AUTHORIZED: { guard: "restartAuthorization", target: "starting", actions: "recordRestart" },
        ...runningStopTransitions,
      },
    },
    stopping: {
      on: {
        DESCENDANTS_QUIESCENT: {
          guard: "descendantsQuiescent",
          actions: "recordDescendantsQuiescent",
        },
        PROCESS_STOPPED: [
          { guard: "matchingRestartableStop", target: "interrupted", actions: "recordStopped" },
          { guard: "matchingTerminalStop", target: "cancelled", actions: "recordStopped" },
        ],
        LOCAL_PROCESS_ABSENT: [
          { guard: "matchingRestartableStop", target: "interrupted", actions: "recordStopped" },
          { guard: "matchingTerminalStop", target: "cancelled", actions: "recordStopped" },
        ],
        PROCESS_STOP_FAILED: [
          { guard: "stopRetryAvailable", actions: "recordStopRetry" },
          { guard: "stopRetryExhausted", target: "failed", actions: "recordStopFailure" },
        ],
        STOP_RETRY_DUE: { guard: "matchingStopRetry", actions: "requestStopRetry" },
        AGENT_CANCEL_REQUESTED: { guard: "terminalCancel", actions: "recordTerminalStop" },
      },
    },
    failing: {
      on: {
        DESCENDANTS_QUIESCENT: { guard: "failingDescendantsQuiescent", target: "failed" },
      },
    },
    completed: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

export type LocalAgentActor = ActorRefFrom<typeof localAgentMachine>;

export const createLocalAgentActor = (input: LocalAgentMachineInput): LocalAgentActor => {
  const actor = createActor(localAgentMachine, { input });
  actor.start();
  return actor;
};
