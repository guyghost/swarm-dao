import { type ActorRefFrom, assign, createActor, setup } from "xstate";

export const REQUIRED_GRAPH_ANCHORS = [
  "model-contract",
  "graph-tests",
  "architecture-contract",
  "repository-ci",
  "runtime-scenario",
  "regression",
] as const;

export const GRAPH_MAX_RETRIES = 2;
export const GRAPH_TERMINAL_STATES = ["succeeded", "failed", "blocked", "cancelled"] as const;

export type GraphAnchorName = (typeof REQUIRED_GRAPH_ANCHORS)[number];
export type GraphSignalSource = "ai" | "tool" | "human" | "system";
export type GraphAnchorStatus = "passed" | "failed";

export type GraphAnchorResult = Readonly<{
  status: GraphAnchorStatus;
  evidence: string;
  attempt: number;
}>;

export type GraphEngineeringContext = {
  runId: string;
  modelHash: string | null;
  approvedModelHash: string | null;
  implementationHash: string | null;
  anchors: Partial<Record<GraphAnchorName, GraphAnchorResult>>;
  attempt: number;
  maxRetries: number;
  terminalReason: string | null;
};

export type GraphEngineeringEvent =
  | { type: "MODEL_DRAFTED"; source: GraphSignalSource; modelHash: string }
  | { type: "MODEL_CONTRACT_VALID"; source: GraphSignalSource; evidence: string }
  | { type: "MODEL_CONTRACT_INVALID"; source: GraphSignalSource; reason: string }
  | { type: "MODEL_APPROVED"; source: GraphSignalSource; modelHash: string }
  | { type: "MODEL_REJECTED"; source: GraphSignalSource; reason: string }
  | { type: "START_IMPLEMENTATION"; source: GraphSignalSource }
  | { type: "IMPLEMENTATION_READY"; source: GraphSignalSource; implementationHash: string }
  | { type: "IMPLEMENTATION_FAILED"; source: GraphSignalSource; reason: string }
  | {
      type: "ANCHOR_RECORDED";
      source: GraphSignalSource;
      anchor: GraphAnchorName;
      status: GraphAnchorStatus;
      evidence: string;
    }
  | { type: "EVALUATE"; source: GraphSignalSource }
  | { type: "RETRY_AUTHORIZED"; source: GraphSignalSource }
  | { type: "PERMISSION_DENIED"; source: GraphSignalSource; reason: string }
  | { type: "CANCEL"; source: GraphSignalSource; reason: string };

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export const isRequiredGraphAnchor = (value: unknown): value is GraphAnchorName =>
  typeof value === "string" && REQUIRED_GRAPH_ANCHORS.includes(value as GraphAnchorName);

const initialContext = (runId: string): GraphEngineeringContext => ({
  runId,
  modelHash: null,
  approvedModelHash: null,
  implementationHash: null,
  anchors: {},
  attempt: 0,
  maxRetries: GRAPH_MAX_RETRIES,
  terminalReason: null,
});

const graphEngineeringSetup = setup({
  types: {
    context: {} as GraphEngineeringContext,
    events: {} as GraphEngineeringEvent,
    input: {} as { runId: string },
  },
  guards: {
    isAiModelDraft: ({ event }) =>
      event.type === "MODEL_DRAFTED" && event.source === "ai" && isNonEmpty(event.modelHash),
    isValidModelContract: ({ event }) =>
      event.type === "MODEL_CONTRACT_VALID" && event.source === "tool" && isNonEmpty(event.evidence),
    isInvalidModelContract: ({ event }) =>
      event.type === "MODEL_CONTRACT_INVALID" && event.source === "tool" && isNonEmpty(event.reason),
    isMatchingHumanApproval: ({ context, event }) =>
      event.type === "MODEL_APPROVED" &&
      event.source === "human" &&
      isNonEmpty(event.modelHash) &&
      event.modelHash === context.modelHash,
    isHumanRejection: ({ event }) =>
      event.type === "MODEL_REJECTED" && event.source === "human" && isNonEmpty(event.reason),
    isSystemStart: ({ event }) => event.type === "START_IMPLEMENTATION" && event.source === "system",
    isAiImplementationReady: ({ event }) =>
      event.type === "IMPLEMENTATION_READY" && event.source === "ai" && isNonEmpty(event.implementationHash),
    isAiImplementationFailure: ({ event }) =>
      event.type === "IMPLEMENTATION_FAILED" && event.source === "ai" && isNonEmpty(event.reason),
    isValidAnchor: ({ event }) =>
      event.type === "ANCHOR_RECORDED" &&
      event.source === "tool" &&
      isRequiredGraphAnchor(event.anchor) &&
      event.anchor !== "model-contract" &&
      (event.status === "passed" || event.status === "failed") &&
      isNonEmpty(event.evidence),
    allAnchorsPassed: ({ context, event }) =>
      event.type === "EVALUATE" &&
      event.source === "system" &&
      REQUIRED_GRAPH_ANCHORS.every((anchor) => {
        const result = context.anchors[anchor];
        return (
          result?.status === "passed" &&
          isNonEmpty(result.evidence) &&
          (anchor === "model-contract" || result.attempt === context.attempt)
        );
      }),
    isSystemEvaluation: ({ event }) => event.type === "EVALUATE" && event.source === "system",
    isHumanRetry: ({ context, event }) =>
      event.type === "RETRY_AUTHORIZED" && event.source === "human" && context.attempt < context.maxRetries,
    isToolPermissionDenial: ({ event }) =>
      event.type === "PERMISSION_DENIED" && event.source === "tool" && isNonEmpty(event.reason),
    isHumanCancellation: ({ event }) => event.type === "CANCEL" && event.source === "human" && isNonEmpty(event.reason),
  },
  actions: {
    recordModel: assign(({ context, event }) =>
      event.type === "MODEL_DRAFTED"
        ? {
            ...context,
            modelHash: event.modelHash,
            approvedModelHash: null,
            implementationHash: null,
            anchors: {},
            attempt: 0,
            terminalReason: null,
          }
        : context,
    ),
    recordModelContract: assign(({ context, event }) =>
      event.type === "MODEL_CONTRACT_VALID"
        ? {
            ...context,
            anchors: {
              ...context.anchors,
              "model-contract": { status: "passed", evidence: event.evidence, attempt: 0 },
            },
          }
        : context,
    ),
    approveModel: assign(({ context, event }) =>
      event.type === "MODEL_APPROVED" ? { ...context, approvedModelHash: event.modelHash } : context,
    ),
    resetRejectedModel: assign(({ context }) => initialContext(context.runId)),
    recordImplementation: assign(({ context, event }) =>
      event.type === "IMPLEMENTATION_READY" ? { ...context, implementationHash: event.implementationHash } : context,
    ),
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
    prepareRetry: assign(({ context }) => ({
      ...context,
      implementationHash: null,
      anchors: context.anchors["model-contract"] ? { "model-contract": context.anchors["model-contract"] } : {},
      attempt: context.attempt + 1,
      terminalReason: null,
    })),
    recordEventReason: assign(({ context, event }) => ({
      ...context,
      terminalReason: "reason" in event && isNonEmpty(event.reason) ? event.reason : "graph run failed",
    })),
    recordVerificationFailure: assign(({ context }) => ({
      ...context,
      terminalReason: "required anchors did not all pass",
    })),
    recordSuccess: assign(({ context }) => ({
      ...context,
      terminalReason: "all required anchors passed",
    })),
  },
});

export const graphEngineeringMachine = graphEngineeringSetup.createMachine({
  id: "swarm-dao-graph-engineering",
  initial: "draft",
  context: ({ input }) => initialContext(input.runId),
  on: {
    PERMISSION_DENIED: {
      guard: "isToolPermissionDenial",
      target: ".blocked",
      actions: "recordEventReason",
    },
    CANCEL: {
      guard: "isHumanCancellation",
      target: ".cancelled",
      actions: "recordEventReason",
    },
  },
  states: {
    draft: {
      on: {
        MODEL_DRAFTED: { guard: "isAiModelDraft", target: "modelReview", actions: "recordModel" },
      },
    },
    modelReview: {
      on: {
        MODEL_CONTRACT_VALID: {
          guard: "isValidModelContract",
          target: "awaitingApproval",
          actions: "recordModelContract",
        },
        MODEL_CONTRACT_INVALID: {
          guard: "isInvalidModelContract",
          target: "failed",
          actions: "recordEventReason",
        },
      },
    },
    awaitingApproval: {
      on: {
        MODEL_APPROVED: { guard: "isMatchingHumanApproval", target: "ready", actions: "approveModel" },
        MODEL_REJECTED: { guard: "isHumanRejection", target: "draft", actions: "resetRejectedModel" },
      },
    },
    ready: {
      on: {
        START_IMPLEMENTATION: { guard: "isSystemStart", target: "implementing" },
      },
    },
    implementing: {
      on: {
        IMPLEMENTATION_READY: {
          guard: "isAiImplementationReady",
          target: "verifying",
          actions: "recordImplementation",
        },
        IMPLEMENTATION_FAILED: [
          {
            guard: ({ context, event }) =>
              event.type === "IMPLEMENTATION_FAILED" &&
              event.source === "ai" &&
              isNonEmpty(event.reason) &&
              context.attempt < context.maxRetries,
            target: "retrying",
            actions: "recordEventReason",
          },
          { guard: "isAiImplementationFailure", target: "failed", actions: "recordEventReason" },
        ],
      },
    },
    verifying: {
      on: {
        ANCHOR_RECORDED: { guard: "isValidAnchor", actions: "recordAnchorOnce" },
        EVALUATE: [
          { guard: "allAnchorsPassed", target: "succeeded", actions: "recordSuccess" },
          {
            guard: ({ context, event }) =>
              event.type === "EVALUATE" && event.source === "system" && context.attempt < context.maxRetries,
            target: "retrying",
            actions: "recordVerificationFailure",
          },
          { guard: "isSystemEvaluation", target: "failed", actions: "recordVerificationFailure" },
        ],
      },
    },
    retrying: {
      on: {
        RETRY_AUTHORIZED: { guard: "isHumanRetry", target: "implementing", actions: "prepareRetry" },
      },
    },
    succeeded: { type: "final" },
    failed: { type: "final" },
    blocked: { type: "final" },
    cancelled: { type: "final" },
  },
});

export type GraphEngineeringActor = ActorRefFrom<typeof graphEngineeringMachine>;

export const createGraphEngineeringActor = (runId: string): GraphEngineeringActor => {
  const actor = createActor(graphEngineeringMachine, { input: { runId } });
  actor.start();
  return actor;
};
