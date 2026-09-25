import { type ActorRefFrom, assign, createActor, setup } from "xstate";

export type DeliveryRiskClass = "unknown" | "standard" | "sensitive";
export type DeliveryTerminalOutcome = "validated" | "rolledBack" | "failed" | "blocked" | "cancelled" | "rejected";
export type DeliverySignalSource = "ai" | "tool" | "human" | "system";

export const SOFTWARE_DELIVERY_STATES = [
  "intake",
  "awaitingRiskReview",
  "draftingGraphModel",
  "validatingGraphModel",
  "awaitingGraphApproval",
  "graphReady",
  "implementing",
  "productVerification",
  "awaitingShipReview",
  "shipReady",
  "awaitingShipCapability",
  "observing",
  "validated",
  "rolledBack",
  "failed",
  "blocked",
  "cancelled",
  "rejected",
] as const;

export type DeliveryEffectCheckpoint = Readonly<{
  name: "ship" | "rollback";
  status: "confirmed";
  evidence: string;
  artifactHash: string | null;
}>;

export type SoftwareDeliveryContext = {
  /** Stable references to child runs; child contexts stay owned by their machines. */
  readonly runId: string;
  readonly productRunId: string;
  readonly graphRunId: string;
  readonly proposalId: string | null;
  readonly scope: string;
  readonly scopeHash: string;
  readonly initialRiskClass: DeliveryRiskClass;
  riskClass: DeliveryRiskClass;
  modelArtifactHash: string | null;
  modelHash: string | null;
  approvedModelHash: string | null;
  implementationHash: string | null;
  artifactHash: string | null;
  effectCheckpoint: DeliveryEffectCheckpoint | null;
  observationEvidence: string[];
  rollbackRequired: boolean;
  rollbackConfirmed: boolean;
  cancellationRequested: boolean;
  cancellationEvidence: string | null;
  outcome: DeliveryTerminalOutcome | null;
  terminalEvidence: string | null;
};

export type SoftwareDeliveryMachineInput = Readonly<{
  runId: string;
  productRunId: string;
  graphRunId: string;
  proposalId?: string | null;
  scope: string;
  scopeHash: string;
  riskClass: DeliveryRiskClass;
}>;

export type SoftwareDeliveryEvent =
  | { type: "INTAKE_ACCEPTED"; source: DeliverySignalSource; evidence: string }
  | { type: "INTAKE_REJECTED"; source: DeliverySignalSource; evidence: string }
  | {
      type: "RISK_CLASSIFICATION_RESOLVED";
      source: DeliverySignalSource;
      riskClass: Exclude<DeliveryRiskClass, "unknown">;
      evidence: string;
    }
  | { type: "GRAPH_MODEL_DRAFTED"; source: DeliverySignalSource; evidence: string; modelArtifactHash?: string }
  | { type: "MODEL_CONTRACT_VALID"; source: DeliverySignalSource; modelHash: string; evidence: string }
  | { type: "MODEL_CONTRACT_INVALID"; source: DeliverySignalSource; evidence: string }
  | { type: "GRAPH_APPROVAL_CONFIRMED"; source: DeliverySignalSource; modelHash: string; evidence: string }
  | { type: "GRAPH_APPROVAL_REJECTED"; source: DeliverySignalSource; evidence: string }
  | { type: "GRAPH_IMPLEMENTATION_STARTED"; source: DeliverySignalSource; evidence: string }
  | {
      type: "GRAPH_IMPLEMENTATION_SUCCEEDED";
      source: DeliverySignalSource;
      implementationHash: string;
      artifactHash: string;
      evidence: string;
    }
  | { type: "CHILD_FAILED"; source: DeliverySignalSource; evidence: string }
  | { type: "CHILD_BLOCKED"; source: DeliverySignalSource; evidence: string }
  | { type: "CHILD_CANCELLED"; source: DeliverySignalSource; evidence: string }
  | { type: "PRODUCT_REVIEW_REQUIRED"; source: DeliverySignalSource; evidence: string }
  | { type: "PRODUCT_REVIEW_BLOCKED"; source: DeliverySignalSource; evidence: string }
  | { type: "PRODUCT_SHIP_READY"; source: DeliverySignalSource; evidence: string }
  | { type: "PRODUCT_SHIP_AUTHORIZED"; source: DeliverySignalSource; evidence: string }
  | { type: "SHIP_CAPABILITY_MISSING"; source: DeliverySignalSource; evidence: string }
  | { type: "SHIP_CAPABILITY_CONFIRMED"; source: DeliverySignalSource; evidence: string }
  | { type: "SHIP_CONFIRMED"; source: DeliverySignalSource; artifactHash: string; evidence: string }
  | { type: "OBSERVATION_SAMPLE_RECORDED"; source: DeliverySignalSource; evidence: string }
  | { type: "OBSERVATION_VALIDATED"; source: DeliverySignalSource; evidence: string }
  | { type: "ROLLBACK_REQUIRED"; source: DeliverySignalSource; evidence: string }
  | { type: "ROLLBACK_CONFIRMED"; source: DeliverySignalSource; evidence: string }
  | { type: "CORRECTIVE_TASK_OPENED"; source: DeliverySignalSource; evidence: string }
  | { type: "CANCEL_REQUESTED"; source: DeliverySignalSource; evidence: string }
  | { type: "CANCEL_SETTLED"; source: DeliverySignalSource; evidence: string };

export const SOFTWARE_DELIVERY_EVENTS = [
  "INTAKE_ACCEPTED",
  "INTAKE_REJECTED",
  "RISK_CLASSIFICATION_RESOLVED",
  "GRAPH_MODEL_DRAFTED",
  "MODEL_CONTRACT_VALID",
  "MODEL_CONTRACT_INVALID",
  "GRAPH_APPROVAL_CONFIRMED",
  "GRAPH_APPROVAL_REJECTED",
  "GRAPH_IMPLEMENTATION_STARTED",
  "GRAPH_IMPLEMENTATION_SUCCEEDED",
  "CHILD_FAILED",
  "CHILD_BLOCKED",
  "CHILD_CANCELLED",
  "PRODUCT_REVIEW_REQUIRED",
  "PRODUCT_REVIEW_BLOCKED",
  "PRODUCT_SHIP_READY",
  "PRODUCT_SHIP_AUTHORIZED",
  "SHIP_CAPABILITY_MISSING",
  "SHIP_CAPABILITY_CONFIRMED",
  "SHIP_CONFIRMED",
  "OBSERVATION_SAMPLE_RECORDED",
  "OBSERVATION_VALIDATED",
  "ROLLBACK_REQUIRED",
  "ROLLBACK_CONFIRMED",
  "CORRECTIVE_TASK_OPENED",
  "CANCEL_REQUESTED",
  "CANCEL_SETTLED",
] as const satisfies readonly SoftwareDeliveryEvent["type"][];

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const initialContext = (input: SoftwareDeliveryMachineInput): SoftwareDeliveryContext => ({
  runId: input.runId,
  productRunId: input.productRunId,
  graphRunId: input.graphRunId,
  proposalId: input.proposalId ?? null,
  scope: input.scope,
  scopeHash: input.scopeHash,
  initialRiskClass: input.riskClass,
  riskClass: input.riskClass,
  modelArtifactHash: null,
  modelHash: null,
  approvedModelHash: null,
  implementationHash: null,
  artifactHash: null,
  effectCheckpoint: null,
  observationEvidence: [],
  rollbackRequired: false,
  rollbackConfirmed: false,
  cancellationRequested: false,
  cancellationEvidence: null,
  outcome: null,
  terminalEvidence: null,
});

const setupDeliveryMachine = setup({
  types: {
    context: {} as SoftwareDeliveryContext,
    events: {} as SoftwareDeliveryEvent,
    input: {} as SoftwareDeliveryMachineInput,
  },
  guards: {
    validIntakeWithUnknownRisk: ({ context, event }) =>
      context.riskClass === "unknown" &&
      event.type === "INTAKE_ACCEPTED" &&
      event.source === "tool" &&
      isNonEmpty(event.evidence),
    validIntakeWithKnownRisk: ({ context, event }) =>
      context.riskClass !== "unknown" &&
      event.type === "INTAKE_ACCEPTED" &&
      event.source === "tool" &&
      isNonEmpty(event.evidence),
    invalidIntake: ({ event }) =>
      event.type === "INTAKE_REJECTED" && event.source === "tool" && isNonEmpty(event.evidence),
    humanRiskResolution: ({ event }) =>
      event.type === "RISK_CLASSIFICATION_RESOLVED" &&
      event.source === "human" &&
      (event.riskClass === "standard" || event.riskClass === "sensitive") &&
      isNonEmpty(event.evidence),
    aiModelDraft: ({ event }) =>
      event.type === "GRAPH_MODEL_DRAFTED" && event.source === "ai" && isNonEmpty(event.evidence),
    validModelContract: ({ event }) =>
      event.type === "MODEL_CONTRACT_VALID" &&
      event.source === "tool" &&
      isNonEmpty(event.modelHash) &&
      isNonEmpty(event.evidence),
    invalidModelContract: ({ event }) =>
      event.type === "MODEL_CONTRACT_INVALID" && event.source === "tool" && isNonEmpty(event.evidence),
    matchingGraphApproval: ({ context, event }) =>
      event.type === "GRAPH_APPROVAL_CONFIRMED" &&
      event.source === "tool" &&
      isNonEmpty(event.modelHash) &&
      event.modelHash === context.modelHash &&
      isNonEmpty(event.evidence),
    graphApprovalRejected: ({ event }) =>
      event.type === "GRAPH_APPROVAL_REJECTED" && event.source === "tool" && isNonEmpty(event.evidence),
    graphImplementationStarted: ({ event }) =>
      event.type === "GRAPH_IMPLEMENTATION_STARTED" && event.source === "tool" && isNonEmpty(event.evidence),
    graphImplementationSucceeded: ({ event }) =>
      event.type === "GRAPH_IMPLEMENTATION_SUCCEEDED" &&
      event.source === "tool" &&
      isNonEmpty(event.implementationHash) &&
      isNonEmpty(event.artifactHash) &&
      isNonEmpty(event.evidence),
    childFailed: ({ event }) => event.type === "CHILD_FAILED" && event.source === "tool" && isNonEmpty(event.evidence),
    childBlocked: ({ event }) =>
      event.type === "CHILD_BLOCKED" && event.source === "tool" && isNonEmpty(event.evidence),
    childCancelled: ({ event }) =>
      event.type === "CHILD_CANCELLED" && event.source === "tool" && isNonEmpty(event.evidence),
    productReviewRequired: ({ event }) =>
      event.type === "PRODUCT_REVIEW_REQUIRED" && event.source === "tool" && isNonEmpty(event.evidence),
    productReviewBlocked: ({ event }) =>
      event.type === "PRODUCT_REVIEW_BLOCKED" && event.source === "tool" && isNonEmpty(event.evidence),
    productShipReady: ({ context, event }) =>
      context.riskClass === "standard" &&
      event.type === "PRODUCT_SHIP_READY" &&
      event.source === "tool" &&
      isNonEmpty(event.evidence),
    productShipAuthorized: ({ context, event }) =>
      context.riskClass === "sensitive" &&
      event.type === "PRODUCT_SHIP_AUTHORIZED" &&
      event.source === "tool" &&
      isNonEmpty(event.evidence),
    shipCapabilityMissing: ({ event }) =>
      event.type === "SHIP_CAPABILITY_MISSING" && event.source === "tool" && isNonEmpty(event.evidence),
    shipCapabilityConfirmed: ({ event }) =>
      event.type === "SHIP_CAPABILITY_CONFIRMED" && event.source === "tool" && isNonEmpty(event.evidence),
    shipConfirmed: ({ context, event }) =>
      event.type === "SHIP_CONFIRMED" &&
      event.source === "tool" &&
      isNonEmpty(event.artifactHash) &&
      event.artifactHash === context.artifactHash &&
      isNonEmpty(event.evidence),
    observationSample: ({ event }) =>
      event.type === "OBSERVATION_SAMPLE_RECORDED" && event.source === "tool" && isNonEmpty(event.evidence),
    observationValidated: ({ event }) =>
      event.type === "OBSERVATION_VALIDATED" && event.source === "tool" && isNonEmpty(event.evidence),
    rollbackRequired: ({ event }) =>
      event.type === "ROLLBACK_REQUIRED" && event.source === "tool" && isNonEmpty(event.evidence),
    rollbackConfirmed: ({ context, event }) =>
      context.rollbackRequired &&
      event.type === "ROLLBACK_CONFIRMED" &&
      event.source === "tool" &&
      isNonEmpty(event.evidence),
    correctiveTaskOpened: ({ context, event }) =>
      context.rollbackConfirmed &&
      event.type === "CORRECTIVE_TASK_OPENED" &&
      event.source === "tool" &&
      isNonEmpty(event.evidence),
    humanCancellation: ({ event }) =>
      event.type === "CANCEL_REQUESTED" && event.source === "human" && isNonEmpty(event.evidence),
    settledCancellation: ({ context, event }) =>
      context.cancellationRequested &&
      event.type === "CANCEL_SETTLED" &&
      event.source === "tool" &&
      isNonEmpty(event.evidence),
  },
  actions: {
    setOutcome: assign(({ context, event }) => {
      const outcomeByEvent: Partial<Record<SoftwareDeliveryEvent["type"], DeliveryTerminalOutcome>> = {
        INTAKE_REJECTED: "rejected",
        MODEL_CONTRACT_INVALID: "failed",
        GRAPH_APPROVAL_REJECTED: "rejected",
        CHILD_FAILED: "failed",
        CHILD_BLOCKED: "blocked",
        CHILD_CANCELLED: "cancelled",
        PRODUCT_REVIEW_BLOCKED: "blocked",
        CANCEL_SETTLED: "cancelled",
      };
      return {
        ...context,
        outcome: outcomeByEvent[event.type] ?? context.outcome,
        terminalEvidence: "evidence" in event ? event.evidence : context.terminalEvidence,
      };
    }),
    resolveRisk: assign(({ context, event }) =>
      event.type === "RISK_CLASSIFICATION_RESOLVED" ? { ...context, riskClass: event.riskClass } : context,
    ),
    recordModelDraft: assign(({ context, event }) =>
      event.type === "GRAPH_MODEL_DRAFTED"
        ? { ...context, modelArtifactHash: event.modelArtifactHash ?? null }
        : context,
    ),
    recordModelHash: assign(({ context, event }) =>
      event.type === "MODEL_CONTRACT_VALID"
        ? { ...context, modelHash: event.modelHash, approvedModelHash: null }
        : context,
    ),
    approveExactModel: assign(({ context, event }) =>
      event.type === "GRAPH_APPROVAL_CONFIRMED" ? { ...context, approvedModelHash: event.modelHash } : context,
    ),
    recordImplementation: assign(({ context, event }) =>
      event.type === "GRAPH_IMPLEMENTATION_SUCCEEDED"
        ? { ...context, implementationHash: event.implementationHash, artifactHash: event.artifactHash }
        : context,
    ),
    recordShip: assign(({ context, event }) =>
      event.type === "SHIP_CONFIRMED"
        ? {
            ...context,
            effectCheckpoint: {
              name: "ship",
              status: "confirmed",
              evidence: event.evidence,
              artifactHash: event.artifactHash,
            },
          }
        : context,
    ),
    recordObservation: assign(({ context, event }) =>
      event.type === "OBSERVATION_SAMPLE_RECORDED"
        ? { ...context, observationEvidence: [...context.observationEvidence, event.evidence] }
        : context,
    ),
    requireRollback: assign(({ context, event }) =>
      event.type === "ROLLBACK_REQUIRED"
        ? { ...context, rollbackRequired: true, terminalEvidence: event.evidence }
        : context,
    ),
    confirmRollback: assign(({ context, event }) =>
      event.type === "ROLLBACK_CONFIRMED"
        ? {
            ...context,
            rollbackConfirmed: true,
            effectCheckpoint: { name: "rollback", status: "confirmed", evidence: event.evidence, artifactHash: null },
          }
        : context,
    ),
    requestCancellation: assign(({ context, event }) =>
      event.type === "CANCEL_REQUESTED"
        ? { ...context, cancellationRequested: true, cancellationEvidence: event.evidence }
        : context,
    ),
    validateDelivery: assign(({ context, event }) => ({
      ...context,
      outcome: "validated",
      terminalEvidence: event.type === "OBSERVATION_VALIDATED" ? event.evidence : context.terminalEvidence,
    })),
    rollBackDelivery: assign(({ context, event }) => ({
      ...context,
      outcome: "rolledBack",
      terminalEvidence: event.type === "CORRECTIVE_TASK_OPENED" ? event.evidence : context.terminalEvidence,
    })),
  },
});

export const softwareDeliveryMachine = setupDeliveryMachine.createMachine({
  id: "swarm-dao-software-delivery",
  initial: "intake",
  context: ({ input }) => initialContext(input),
  on: {
    CHILD_FAILED: { guard: "childFailed", target: ".failed", actions: "setOutcome" },
    CHILD_BLOCKED: { guard: "childBlocked", target: ".blocked", actions: "setOutcome" },
    CHILD_CANCELLED: { guard: "childCancelled", target: ".cancelled", actions: "setOutcome" },
    CANCEL_REQUESTED: { guard: "humanCancellation", actions: "requestCancellation" },
    CANCEL_SETTLED: { guard: "settledCancellation", target: ".cancelled", actions: "setOutcome" },
  },
  states: {
    intake: {
      on: {
        INTAKE_ACCEPTED: [
          { guard: "validIntakeWithUnknownRisk", target: "awaitingRiskReview" },
          { guard: "validIntakeWithKnownRisk", target: "draftingGraphModel" },
        ],
        INTAKE_REJECTED: { guard: "invalidIntake", target: "rejected", actions: "setOutcome" },
      },
    },
    awaitingRiskReview: {
      on: {
        RISK_CLASSIFICATION_RESOLVED: {
          guard: "humanRiskResolution",
          target: "draftingGraphModel",
          actions: "resolveRisk",
        },
      },
    },
    draftingGraphModel: {
      on: {
        GRAPH_MODEL_DRAFTED: { guard: "aiModelDraft", target: "validatingGraphModel", actions: "recordModelDraft" },
      },
    },
    validatingGraphModel: {
      on: {
        MODEL_CONTRACT_VALID: {
          guard: "validModelContract",
          target: "awaitingGraphApproval",
          actions: "recordModelHash",
        },
        MODEL_CONTRACT_INVALID: { guard: "invalidModelContract", target: "failed", actions: "setOutcome" },
      },
    },
    awaitingGraphApproval: {
      on: {
        GRAPH_APPROVAL_CONFIRMED: {
          guard: "matchingGraphApproval",
          target: "graphReady",
          actions: "approveExactModel",
        },
        GRAPH_APPROVAL_REJECTED: { guard: "graphApprovalRejected", target: "rejected", actions: "setOutcome" },
      },
    },
    graphReady: {
      on: {
        GRAPH_IMPLEMENTATION_STARTED: { guard: "graphImplementationStarted", target: "implementing" },
      },
    },
    implementing: {
      on: {
        GRAPH_IMPLEMENTATION_SUCCEEDED: {
          guard: "graphImplementationSucceeded",
          target: "productVerification",
          actions: "recordImplementation",
        },
      },
    },
    productVerification: {
      on: {
        PRODUCT_REVIEW_REQUIRED: [
          {
            guard: ({ context, event }) =>
              context.riskClass === "sensitive" &&
              event.type === "PRODUCT_REVIEW_REQUIRED" &&
              event.source === "tool" &&
              isNonEmpty(event.evidence),
            target: "awaitingShipReview",
          },
          { guard: "productReviewRequired", target: "blocked", actions: "setOutcome" },
        ],
        PRODUCT_REVIEW_BLOCKED: { guard: "productReviewBlocked", target: "blocked", actions: "setOutcome" },
        PRODUCT_SHIP_READY: { guard: "productShipReady", target: "shipReady" },
      },
    },
    awaitingShipReview: {
      on: {
        PRODUCT_SHIP_AUTHORIZED: { guard: "productShipAuthorized", target: "shipReady" },
        PRODUCT_REVIEW_BLOCKED: { guard: "productReviewBlocked", target: "blocked", actions: "setOutcome" },
      },
    },
    shipReady: {
      on: {
        SHIP_CAPABILITY_MISSING: { guard: "shipCapabilityMissing", target: "awaitingShipCapability" },
        SHIP_CONFIRMED: { guard: "shipConfirmed", target: "observing", actions: "recordShip" },
      },
    },
    awaitingShipCapability: {
      on: {
        SHIP_CAPABILITY_CONFIRMED: { guard: "shipCapabilityConfirmed", target: "shipReady" },
      },
    },
    observing: {
      on: {
        OBSERVATION_SAMPLE_RECORDED: { guard: "observationSample", actions: "recordObservation" },
        OBSERVATION_VALIDATED: { guard: "observationValidated", target: "validated", actions: "validateDelivery" },
        ROLLBACK_REQUIRED: { guard: "rollbackRequired", actions: "requireRollback" },
        ROLLBACK_CONFIRMED: { guard: "rollbackConfirmed", actions: "confirmRollback" },
        CORRECTIVE_TASK_OPENED: { guard: "correctiveTaskOpened", target: "rolledBack", actions: "rollBackDelivery" },
      },
    },
    validated: { type: "final" },
    rolledBack: { type: "final" },
    failed: { type: "final" },
    blocked: { type: "final" },
    cancelled: { type: "final" },
    rejected: { type: "final" },
  },
});

export type SoftwareDeliveryActor = ActorRefFrom<typeof softwareDeliveryMachine>;

export const createSoftwareDeliveryActor = (input: SoftwareDeliveryMachineInput): SoftwareDeliveryActor => {
  const actor = createActor(softwareDeliveryMachine, { input });
  actor.start();
  return actor;
};
