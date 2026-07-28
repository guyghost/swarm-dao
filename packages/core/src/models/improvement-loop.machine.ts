import { type ActorRefFrom, assign, createActor, setup } from "xstate";

export const REQUIRED_IMPROVEMENT_ANCHORS = [
  "counter-metric-paired",
  "drift-audit",
  "arbitration-policy",
  "anchor-reality",
  "frozen-set-intact",
  "regression",
] as const;

export const IMPROVEMENT_MAX_RETRIES = 2;
export const IMPROVEMENT_TERMINAL_STATES = ["succeeded", "failed", "blocked", "cancelled"] as const;

export type ImprovementAnchorName = (typeof REQUIRED_IMPROVEMENT_ANCHORS)[number];
export type ImprovementSignalSource = "ai" | "tool" | "human" | "system";
export type AnchorStatus = "passed" | "failed";
export type DriftClass = "none" | "partial" | "detached";

export type Sample = Readonly<{ value: string; evidence: string }>;

export type ImprovementAnchorResult = Readonly<{
  status: AnchorStatus;
  evidence: string;
  attempt: number;
}>;

export type ImprovementContext = {
  cycleId: string;
  scope: string;
  referenceHash: string | null;
  approvedReferenceHash: string | null;
  metric: Sample | null;
  counterMetric: Sample | null;
  driftClass: DriftClass | null;
  arbitrationOutcome: string | null;
  anchors: Partial<Record<ImprovementAnchorName, ImprovementAnchorResult>>;
  attempt: number;
  maxRetries: number;
  terminalReason: string | null;
};

export type ImprovementEvent =
  | { type: "METRIC_SAMPLED"; source: ImprovementSignalSource; sample: Sample }
  | { type: "COUNTER_SAMPLED"; source: ImprovementSignalSource; sample: Sample }
  | { type: "SAMPLES_SEALED"; source: ImprovementSignalSource }
  | { type: "DRIFT_ESTIMATE"; source: ImprovementSignalSource; driftClass: DriftClass }
  | { type: "ARBITRATION"; source: ImprovementSignalSource; outcome: string }
  | {
      type: "ANCHOR_RECORDED";
      source: ImprovementSignalSource;
      anchor: ImprovementAnchorName;
      status: AnchorStatus;
      evidence: string;
    }
  | { type: "EVALUATE"; source: ImprovementSignalSource }
  | { type: "REFERENCE_CHANGE_APPROVED"; source: ImprovementSignalSource; referenceHash: string }
  | { type: "REFERENCE_CHANGE_REJECTED"; source: ImprovementSignalSource; reason: string }
  | { type: "RETRY_AUTHORIZED"; source: ImprovementSignalSource }
  | { type: "PERMISSION_DENIED"; source: ImprovementSignalSource; reason: string }
  | { type: "CANCEL"; source: ImprovementSignalSource; reason: string };

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isSample = (value: unknown): value is Sample =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  "evidence" in value &&
  isNonEmpty((value as Sample).value) &&
  isNonEmpty((value as Sample).evidence);

const ANCHORS_THAT_SURVIVE_RETRY: ReadonlySet<ImprovementAnchorName> = new Set([
  "counter-metric-paired",
  "frozen-set-intact",
]);

export const isRequiredImprovementAnchor = (value: unknown): value is ImprovementAnchorName =>
  typeof value === "string" && REQUIRED_IMPROVEMENT_ANCHORS.includes(value as ImprovementAnchorName);

/** Deterministic arbitration over paired signals. Lives in the model; called by the tool adapter. */
export const arbitratePairedSignals = (
  metric: Sample | null,
  counterMetric: Sample | null,
): { outcome: string; arbitrationPolicyPassed: boolean } => {
  if (!metric || !counterMetric) return { outcome: "missing-pair", arbitrationPolicyPassed: false };
  // Fixed policy: the counter-metric may veto an optimizing metric that moved the
  // wrong way. This is deterministic; the AI never supplies the outcome.
  const metricUp = metric.value !== "declined";
  const counterUp = counterMetric.value !== "declined";
  if (metricUp && !counterUp) {
    return { outcome: "counter-veto:metric-rose-counter-fell", arbitrationPolicyPassed: false };
  }
  return { outcome: "balanced", arbitrationPolicyPassed: true };
};

/** Deterministic frozen-set integrity check. Lives in the model; called by the tool adapter. */
export const assertFrozenSetIntact = (currentHash: string, expectedHash: string): boolean =>
  isNonEmpty(currentHash) && isNonEmpty(expectedHash) && currentHash === expectedHash;

const initialContext = (input: ImprovementMachineInput): ImprovementContext => ({
  cycleId: input.cycleId,
  scope: input.scope,
  referenceHash: input.referenceHash,
  approvedReferenceHash: null,
  metric: null,
  counterMetric: null,
  driftClass: null,
  arbitrationOutcome: null,
  anchors: {},
  attempt: 0,
  maxRetries: IMPROVEMENT_MAX_RETRIES,
  terminalReason: null,
});

export interface ImprovementMachineInput {
  cycleId: string;
  scope: string;
  referenceHash: string;
}

const improvementSetup = setup({
  types: {
    context: {} as ImprovementContext,
    events: {} as ImprovementEvent,
    input: {} as ImprovementMachineInput,
  },
  guards: {
    isAiMetricSample: ({ event }) => event.type === "METRIC_SAMPLED" && event.source === "ai" && isSample(event.sample),
    isAiCounterSample: ({ event }) =>
      event.type === "COUNTER_SAMPLED" && event.source === "ai" && isSample(event.sample),
    isToolSamplesSealed: ({ context, event }) =>
      event.type === "SAMPLES_SEALED" &&
      event.source === "tool" &&
      context.metric !== null &&
      context.counterMetric !== null,
    isAiDriftEstimate: ({ event }) =>
      event.type === "DRIFT_ESTIMATE" &&
      event.source === "ai" &&
      ["none", "partial", "detached"].includes(event.driftClass),
    isToolArbitration: ({ event }) =>
      event.type === "ARBITRATION" && event.source === "tool" && isNonEmpty(event.outcome),
    isValidAnchor: ({ event }) =>
      event.type === "ANCHOR_RECORDED" &&
      event.source === "tool" &&
      isRequiredImprovementAnchor(event.anchor) &&
      (event.status === "passed" || event.status === "failed") &&
      isNonEmpty(event.evidence),
    isSystemEvaluate: ({ event }) => event.type === "EVALUATE" && event.source === "system",
    isDetached: ({ context }) => context.driftClass === "detached",
    allAnchorsPassed: ({ context }) =>
      REQUIRED_IMPROVEMENT_ANCHORS.every((anchor) => {
        const result = context.anchors[anchor];
        return (
          result?.status === "passed" &&
          isNonEmpty(result.evidence) &&
          (ANCHORS_THAT_SURVIVE_RETRY.has(anchor) || result.attempt === context.attempt)
        );
      }),
    canRetry: ({ context }) => context.attempt < context.maxRetries,
    isMatchingReferenceApproval: ({ context, event }) =>
      event.type === "REFERENCE_CHANGE_APPROVED" &&
      event.source === "human" &&
      isNonEmpty(event.referenceHash) &&
      event.referenceHash === context.referenceHash,
    isHumanReferenceRejection: ({ event }) =>
      event.type === "REFERENCE_CHANGE_REJECTED" && event.source === "human" && isNonEmpty(event.reason),
    isHumanRetry: ({ context, event }) =>
      event.type === "RETRY_AUTHORIZED" && event.source === "human" && context.attempt < context.maxRetries,
    isToolPermissionDenial: ({ event }) =>
      event.type === "PERMISSION_DENIED" && event.source === "tool" && isNonEmpty(event.reason),
    isHumanCancellation: ({ event }) => event.type === "CANCEL" && event.source === "human" && isNonEmpty(event.reason),
  },
  actions: {
    recordMetric: assign(({ context, event }) =>
      event.type === "METRIC_SAMPLED" ? { ...context, metric: event.sample } : context,
    ),
    recordCounter: assign(({ context, event }) =>
      event.type === "COUNTER_SAMPLED" ? { ...context, counterMetric: event.sample } : context,
    ),
    recordCounterMetricPaired: assign(({ context }) => ({
      ...context,
      anchors: {
        ...context.anchors,
        "counter-metric-paired": { status: "passed", evidence: "sample-gate-sealed", attempt: context.attempt },
      },
    })),
    recordDrift: assign(({ context, event }) =>
      event.type === "DRIFT_ESTIMATE" ? { ...context, driftClass: event.driftClass } : context,
    ),
    // The model - not the tool adapter - computes the arbitration outcome from
    // the sealed samples, so a counter-veto actually fails this anchor (blocking
    // succeeded) and a forged tool event cannot bypass the policy.
    recordArbitration: assign(({ context }) => {
      const { outcome, arbitrationPolicyPassed } = arbitratePairedSignals(context.metric, context.counterMetric);
      return {
        ...context,
        arbitrationOutcome: outcome,
        anchors: {
          ...context.anchors,
          "arbitration-policy": {
            status: arbitrationPolicyPassed ? "passed" : "failed",
            evidence: outcome,
            attempt: context.attempt,
          },
        },
      };
    }),
    recordAnchorOnce: assign(({ context, event }) => {
      if (event.type !== "ANCHOR_RECORDED" || context.anchors[event.anchor] !== undefined) return context;
      return {
        ...context,
        anchors: {
          ...context.anchors,
          [event.anchor]: { status: event.status, evidence: event.evidence, attempt: context.attempt },
        },
      };
    }),
    applyReferenceApproval: assign(({ context, event }) => ({
      ...context,
      approvedReferenceHash: event.type === "REFERENCE_CHANGE_APPROVED" ? event.referenceHash : null,
      metric: null,
      counterMetric: null,
      driftClass: null,
      arbitrationOutcome: null,
      anchors: {},
      attempt: 0,
      terminalReason: null,
    })),
    prepareRetry: assign(({ context }) => {
      const retained: Partial<Record<ImprovementAnchorName, ImprovementAnchorResult>> = {};
      for (const anchor of ANCHORS_THAT_SURVIVE_RETRY) {
        const result = context.anchors[anchor];
        if (result) retained[anchor] = result;
      }
      return {
        ...context,
        metric: null,
        counterMetric: null,
        driftClass: null,
        arbitrationOutcome: null,
        anchors: retained,
        attempt: context.attempt + 1,
        terminalReason: null,
      };
    }),
    recordEventReason: assign(({ context, event }) => ({
      ...context,
      terminalReason: "reason" in event && isNonEmpty(event.reason) ? event.reason : "improvement cycle failed",
    })),
    recordVerificationFailure: assign(({ context }) => ({
      ...context,
      terminalReason: "required ground-contact anchors did not all pass",
    })),
    recordDetachedAdjustment: assign(({ context }) => ({
      ...context,
      terminalReason: "drift detached; reference under human review",
    })),
    recordSuccess: assign(({ context }) => ({
      ...context,
      terminalReason: "all required ground-contact anchors passed",
    })),
  },
});

export const improvementMachine = improvementSetup.createMachine({
  id: "swarm-dao-improvement-loop",
  initial: "sampling",
  context: ({ input }) => initialContext(input),
  on: {
    PERMISSION_DENIED: { guard: "isToolPermissionDenial", target: ".blocked", actions: "recordEventReason" },
    CANCEL: { guard: "isHumanCancellation", target: ".cancelled", actions: "recordEventReason" },
  },
  states: {
    sampling: {
      on: {
        METRIC_SAMPLED: { guard: "isAiMetricSample", actions: "recordMetric" },
        COUNTER_SAMPLED: { guard: "isAiCounterSample", actions: "recordCounter" },
        SAMPLES_SEALED: {
          guard: "isToolSamplesSealed",
          target: "auditing",
          actions: "recordCounterMetricPaired",
        },
      },
    },
    auditing: {
      on: {
        DRIFT_ESTIMATE: { guard: "isAiDriftEstimate", target: "arbitrating", actions: "recordDrift" },
      },
    },
    arbitrating: {
      on: {
        ARBITRATION: { guard: "isToolArbitration", target: "grounding", actions: "recordArbitration" },
      },
    },
    grounding: {
      on: {
        ANCHOR_RECORDED: { guard: "isValidAnchor", actions: "recordAnchorOnce" },
        EVALUATE: { guard: "isSystemEvaluate", target: "evaluating" },
      },
    },
    evaluating: {
      always: [
        { guard: "isDetached", target: "adjusting", actions: "recordDetachedAdjustment" },
        { guard: "allAnchorsPassed", target: "succeeded", actions: "recordSuccess" },
        { guard: "canRetry", target: "retrying", actions: "recordVerificationFailure" },
        { target: "failed", actions: "recordVerificationFailure" },
      ],
    },
    adjusting: {
      on: {
        REFERENCE_CHANGE_APPROVED: {
          guard: "isMatchingReferenceApproval",
          target: "sampling",
          actions: "applyReferenceApproval",
        },
        REFERENCE_CHANGE_REJECTED: {
          guard: "isHumanReferenceRejection",
          target: "failed",
          actions: "recordEventReason",
        },
      },
    },
    retrying: {
      on: {
        RETRY_AUTHORIZED: { guard: "isHumanRetry", target: "sampling", actions: "prepareRetry" },
      },
    },
    succeeded: { type: "final" },
    failed: { type: "final" },
    blocked: { type: "final" },
    cancelled: { type: "final" },
  },
});

export type ImprovementActor = ActorRefFrom<typeof improvementMachine>;

export const createImprovementActor = (input: ImprovementMachineInput): ImprovementActor => {
  const actor = createActor(improvementMachine, { input });
  actor.start();
  return actor;
};
