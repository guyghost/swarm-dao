import { type ActorRefFrom, assign, createActor, setup } from "xstate";

export const ORCHESTRATOR_TERMINAL_STATES = ["idle", "cancelled"] as const;
export const ORCHESTRATOR_HUMAN_GATED_STATES = ["awaitingHumanCycleDecision", "workerFailed", "halted"] as const;
export const ORCHESTRATOR_MAX_WORKER_RETRIES = 2;
export const ORCHESTRATOR_MIN_COOLDOWN_MS = 60_000;

export type OrchestratorSignalSource = "tool" | "human" | "system";
export type WorkerPhase = "sampling" | "auditing";

export type OrchestratorContext = {
  seriesId: string;
  started: boolean;
  scope: string | null;
  referenceHash: string | null;
  cooldownMs: number | null;
  improvementCycleId: string | null;
  cycleSequence: number;
  workerPhase: WorkerPhase | null;
  pendingReason: string | null;
  terminalReason: string | null;
};

export type OrchestratorEvent =
  | { type: "START_SERIES"; source: OrchestratorSignalSource; scope: string; referenceHash: string; cooldownMs: number }
  | { type: "CYCLE_INITIALIZED"; source: OrchestratorSignalSource; cycleId: string }
  | { type: "WORKERS_HARVESTED"; source: OrchestratorSignalSource }
  | { type: "SAMPLES_SUBMITTED"; source: OrchestratorSignalSource }
  | { type: "ARBITRATION_SUBMITTED"; source: OrchestratorSignalSource }
  | { type: "ANCHORS_SUBMITTED"; source: OrchestratorSignalSource }
  | { type: "EVALUATE_SUBMITTED"; source: OrchestratorSignalSource }
  | { type: "CYCLE_SUCCEEDED"; source: OrchestratorSignalSource }
  | { type: "CYCLE_AWAITING_HUMAN"; source: OrchestratorSignalSource }
  | { type: "CYCLE_RESUMED"; source: OrchestratorSignalSource }
  | { type: "CYCLE_FAILED"; source: OrchestratorSignalSource; reason: string }
  | { type: "CYCLE_BLOCKED"; source: OrchestratorSignalSource; reason: string }
  | { type: "CYCLE_CANCELLED"; source: OrchestratorSignalSource; reason: string }
  | { type: "COOLDOWN_ELAPSED"; source: OrchestratorSignalSource }
  | { type: "WORKERS_FAILED"; source: OrchestratorSignalSource; reason: string; phase: WorkerPhase }
  | { type: "SIGNAL_REJECTED"; source: OrchestratorSignalSource; issues: readonly string[] }
  | { type: "RETRY_WORKERS"; source: OrchestratorSignalSource }
  | { type: "RESTART_SERIES"; source: OrchestratorSignalSource }
  | { type: "CANCEL_SERIES"; source: OrchestratorSignalSource; reason: string };

export interface OrchestratorMachineInput {
  seriesId: string;
}

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isWorkerPhase = (value: unknown): value is WorkerPhase => value === "sampling" || value === "auditing";

const initialContext = (input: OrchestratorMachineInput): OrchestratorContext => ({
  seriesId: input.seriesId,
  started: false,
  scope: null,
  referenceHash: null,
  cooldownMs: null,
  improvementCycleId: null,
  cycleSequence: 0,
  workerPhase: null,
  pendingReason: null,
  terminalReason: null,
});

const orchestratorSetup = setup({
  types: {
    context: {} as OrchestratorContext,
    events: {} as OrchestratorEvent,
    input: {} as OrchestratorMachineInput,
  },
  guards: {
    isHumanStart: ({ event }) =>
      event.type === "START_SERIES" &&
      event.source === "human" &&
      isNonEmpty(event.scope) &&
      isNonEmpty(event.referenceHash) &&
      Number.isInteger(event.cooldownMs) &&
      event.cooldownMs >= ORCHESTRATOR_MIN_COOLDOWN_MS,
    isToolCycleInitialized: ({ event }) =>
      event.type === "CYCLE_INITIALIZED" && event.source === "tool" && isNonEmpty(event.cycleId),
    isToolWorkersHarvested: ({ event }) => event.type === "WORKERS_HARVESTED" && event.source === "tool",
    isToolSamplesSubmitted: ({ event }) => event.type === "SAMPLES_SUBMITTED" && event.source === "tool",
    isToolArbitrationSubmitted: ({ event }) => event.type === "ARBITRATION_SUBMITTED" && event.source === "tool",
    isToolAnchorsSubmitted: ({ event }) => event.type === "ANCHORS_SUBMITTED" && event.source === "tool",
    isToolEvaluateSubmitted: ({ event }) => event.type === "EVALUATE_SUBMITTED" && event.source === "tool",
    isSystemCycleSucceeded: ({ event }) => event.type === "CYCLE_SUCCEEDED" && event.source === "system",
    isSystemCycleAwaitingHuman: ({ event }) => event.type === "CYCLE_AWAITING_HUMAN" && event.source === "system",
    isSystemCycleResumed: ({ event }) => event.type === "CYCLE_RESUMED" && event.source === "system",
    isSystemCycleFailed: ({ event }) =>
      event.type === "CYCLE_FAILED" && event.source === "system" && isNonEmpty(event.reason),
    isSystemCycleBlocked: ({ event }) =>
      event.type === "CYCLE_BLOCKED" && event.source === "system" && isNonEmpty(event.reason),
    isSystemCycleCancelled: ({ event }) =>
      event.type === "CYCLE_CANCELLED" && event.source === "system" && isNonEmpty(event.reason),
    isSystemCooldownElapsed: ({ event }) => event.type === "COOLDOWN_ELAPSED" && event.source === "system",
    isToolWorkersFailed: ({ event }) =>
      event.type === "WORKERS_FAILED" &&
      event.source === "tool" &&
      isNonEmpty(event.reason) &&
      isWorkerPhase(event.phase),
    isToolSignalRejected: ({ event }) =>
      event.type === "SIGNAL_REJECTED" && event.source === "tool" && event.issues.some(isNonEmpty),
    isHumanRetryWorkers: ({ event }) => event.type === "RETRY_WORKERS" && event.source === "human",
    isHumanRetryOfDriftWorker: ({ context, event }) =>
      event.type === "RETRY_WORKERS" && event.source === "human" && context.workerPhase === "auditing",
    isHumanRestart: ({ event }) => event.type === "RESTART_SERIES" && event.source === "human",
    isHumanCancellation: ({ context, event }) =>
      event.type === "CANCEL_SERIES" && event.source === "human" && isNonEmpty(event.reason) && context.started,
  },
  actions: {
    startSeries: assign(({ context, event }) => ({
      ...context,
      started: true,
      scope: event.type === "START_SERIES" ? event.scope : context.scope,
      referenceHash: event.type === "START_SERIES" ? event.referenceHash : context.referenceHash,
      cooldownMs: event.type === "START_SERIES" ? event.cooldownMs : context.cooldownMs,
      pendingReason: null,
    })),
    openCycle: assign(({ context, event }) => ({
      ...context,
      improvementCycleId: event.type === "CYCLE_INITIALIZED" ? event.cycleId : context.improvementCycleId,
      cycleSequence: context.cycleSequence + 1,
      pendingReason: null,
    })),
    clearCycleCorrelation: assign(({ context }) => ({
      ...context,
      improvementCycleId: null,
    })),
    recordSampleWorkerFailure: assign(({ context, event }) => ({
      ...context,
      workerPhase: "sampling",
      pendingReason:
        event.type === "SIGNAL_REJECTED" ? event.issues.filter(isNonEmpty).join("; ") : context.pendingReason,
    })),
    recordDriftWorkerFailure: assign(({ context, event }) => ({
      ...context,
      workerPhase: "auditing",
      pendingReason:
        event.type === "SIGNAL_REJECTED" ? event.issues.filter(isNonEmpty).join("; ") : context.pendingReason,
    })),
    recordWorkersFailure: assign(({ context, event }) => ({
      ...context,
      workerPhase: event.type === "WORKERS_FAILED" ? event.phase : context.workerPhase,
      pendingReason: event.type === "WORKERS_FAILED" ? event.reason : context.pendingReason,
    })),
    clearWorkerFailure: assign(({ context }) => ({
      ...context,
      workerPhase: null,
      pendingReason: null,
    })),
    recordHaltReason: assign(({ context, event }) => ({
      ...context,
      pendingReason:
        event.type === "CYCLE_FAILED" || event.type === "CYCLE_BLOCKED" || event.type === "CYCLE_CANCELLED"
          ? event.reason
          : context.pendingReason,
    })),
    recordCancellation: assign(({ context, event }) => ({
      ...context,
      terminalReason: event.type === "CANCEL_SERIES" ? event.reason : "series cancelled",
    })),
  },
});

export const orchestratorMachine = orchestratorSetup.createMachine({
  id: "swarm-dao-improvement-orchestrator",
  initial: "idle",
  context: ({ input }) => initialContext(input),
  // Human cancellation is accepted from every active state; the `started`
  // guard keeps the terminal `idle` state inert, and `cancelled` (final)
  // rejects all later events.
  on: {
    CANCEL_SERIES: { guard: "isHumanCancellation", target: ".cancelled", actions: "recordCancellation" },
  },
  states: {
    idle: {
      on: {
        START_SERIES: { guard: "isHumanStart", target: "preparing", actions: "startSeries" },
      },
    },
    preparing: {
      on: {
        CYCLE_INITIALIZED: { guard: "isToolCycleInitialized", target: "sampling", actions: "openCycle" },
      },
    },
    sampling: {
      on: {
        WORKERS_HARVESTED: { guard: "isToolWorkersHarvested", target: "sealing" },
        WORKERS_FAILED: { guard: "isToolWorkersFailed", target: "workerFailed", actions: "recordWorkersFailure" },
      },
    },
    sealing: {
      on: {
        SAMPLES_SUBMITTED: { guard: "isToolSamplesSubmitted", target: "auditing" },
        SIGNAL_REJECTED: {
          guard: "isToolSignalRejected",
          target: "workerFailed",
          actions: "recordSampleWorkerFailure",
        },
      },
    },
    auditing: {
      on: {
        WORKERS_HARVESTED: { guard: "isToolWorkersHarvested", target: "arbitrating" },
        WORKERS_FAILED: { guard: "isToolWorkersFailed", target: "workerFailed", actions: "recordWorkersFailure" },
      },
    },
    arbitrating: {
      on: {
        ARBITRATION_SUBMITTED: { guard: "isToolArbitrationSubmitted", target: "grounding" },
        SIGNAL_REJECTED: { guard: "isToolSignalRejected", target: "workerFailed", actions: "recordDriftWorkerFailure" },
      },
    },
    grounding: {
      on: {
        ANCHORS_SUBMITTED: { guard: "isToolAnchorsSubmitted", target: "evaluating" },
      },
    },
    evaluating: {
      on: {
        EVALUATE_SUBMITTED: { guard: "isToolEvaluateSubmitted", target: "observing" },
      },
    },
    observing: {
      on: {
        CYCLE_SUCCEEDED: { guard: "isSystemCycleSucceeded", target: "cooldown", actions: "clearCycleCorrelation" },
        CYCLE_AWAITING_HUMAN: { guard: "isSystemCycleAwaitingHuman", target: "awaitingHumanCycleDecision" },
        CYCLE_FAILED: { guard: "isSystemCycleFailed", target: "halted", actions: "recordHaltReason" },
        CYCLE_BLOCKED: { guard: "isSystemCycleBlocked", target: "halted", actions: "recordHaltReason" },
        CYCLE_CANCELLED: { guard: "isSystemCycleCancelled", target: "halted", actions: "recordHaltReason" },
      },
    },
    cooldown: {
      on: {
        COOLDOWN_ELAPSED: { guard: "isSystemCooldownElapsed", target: "preparing" },
      },
    },
    awaitingHumanCycleDecision: {
      on: {
        CYCLE_RESUMED: { guard: "isSystemCycleResumed", target: "sampling", actions: "clearWorkerFailure" },
      },
    },
    workerFailed: {
      on: {
        // The human retry returns to the recorded failed phase, not blindly
        // to sampling: a drift-worker failure must not rerun the sensors.
        RETRY_WORKERS: [
          { guard: "isHumanRetryOfDriftWorker", target: "auditing", actions: "clearWorkerFailure" },
          { guard: "isHumanRetryWorkers", target: "sampling", actions: "clearWorkerFailure" },
        ],
      },
    },
    halted: {
      on: {
        RESTART_SERIES: { guard: "isHumanRestart", target: "preparing", actions: "clearWorkerFailure" },
      },
    },
    cancelled: { type: "final" },
  },
});

export type OrchestratorActor = ActorRefFrom<typeof orchestratorMachine>;

export const createOrchestratorActor = (input: OrchestratorMachineInput): OrchestratorActor => {
  const actor = createActor(orchestratorMachine, { input });
  actor.start();
  return actor;
};
