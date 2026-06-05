import { setup, assign } from "xstate";
import type {
  Proposal,
  ProposalStatus,
  PipelineStage,
  RiskZone,
} from "../types/index.js";

// ============================================================
// Types pour la machine
// ============================================================

export interface ProposalContext {
  proposal: Proposal;
  stage: PipelineStage;
  status: ProposalStatus;
  riskZone?: RiskZone;
  deliberationCount: number;
  retryCount: number;
  errorMessage?: string;
  lastTransitionTime: string;
}

export type ProposalEvent =
  | { type: "SUBMIT" }
  | { type: "QUALIFY" }
  | { type: "ANALYZE" }
  | { type: "CRITIQUE" }
  | { type: "SCORE" }
  | { type: "SEND_TO_COUNCIL" }
  | { type: "VOTE" }
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "REQUEST_SPEC" }
  | { type: "REVIEW_SPEC" }
  | { type: "APPROVE_SPEC" }
  | { type: "EXECUTION_GATE_PASS" }
  | { type: "EXECUTION_GATE_FAIL" }
  | { type: "EXECUTE" }
  | { type: "EXECUTION_SUCCESS" }
  | { type: "EXECUTION_FAILED" }
  | { type: "POSTMORTEM" }
  | { type: "RETRY" }
  | { type: "DISCARD" }
  | { type: "ERROR"; message: string };

// ============================================================
// XState Machine Definition
// ============================================================

export const proposalMachine = setup({
  types: {
    context: {} as ProposalContext,
    events: {} as ProposalEvent,
  },
}).createMachine({
  id: "proposalLifecycle",
  initial: "draft",
  context: {
    proposal: {} as Proposal,
    stage: "intake" as PipelineStage,
    status: "open" as ProposalStatus,
    riskZone: undefined,
    deliberationCount: 0,
    retryCount: 0,
    lastTransitionTime: new Date().toISOString(),
  } as ProposalContext,

  states: {
    // ───────────────────────────────────────────────────────
    // INTAKE PHASE
    // ───────────────────────────────────────────────────────
    draft: {
      on: {
        SUBMIT: {
          target: "intake",
          actions: assign({
            status: "open",
            stage: "intake",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    intake: {
      on: {
        QUALIFY: {
          target: "qualification",
          actions: assign({
            status: "open",
            stage: "qualification",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // QUALIFICATION PHASE
    // ───────────────────────────────────────────────────────
    qualification: {
      on: {
        ANALYZE: {
          target: "analysis",
          actions: assign({
            status: "open",
            stage: "analysis",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // ANALYSIS PHASE
    // ───────────────────────────────────────────────────────
    analysis: {
      on: {
        CRITIQUE: {
          target: "critique",
          actions: assign({
            status: "deliberating",
            stage: "critique",
            deliberationCount: ({ context }) => context.deliberationCount + 1,
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // CRITIQUE PHASE
    // ───────────────────────────────────────────────────────
    critique: {
      on: {
        SCORE: {
          target: "scoring",
          actions: assign({
            status: "deliberating",
            stage: "scoring",
            deliberationCount: ({ context }) => context.deliberationCount + 1,
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // SCORING PHASE
    // ───────────────────────────────────────────────────────
    scoring: {
      on: {
        SEND_TO_COUNCIL: {
          target: "council",
          actions: assign({
            status: "deliberating",
            stage: "council",
            deliberationCount: ({ context }) => context.deliberationCount + 1,
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // COUNCIL PHASE
    // ───────────────────────────────────────────────────────
    council: {
      on: {
        VOTE: {
          target: "voting",
          actions: assign({
            status: "deliberating",
            stage: "vote",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // VOTING PHASE
    // ───────────────────────────────────────────────────────
    voting: {
      on: {
        APPROVE: {
          target: "specDraft",
          actions: assign({
            status: "approved",
            stage: "council",
            retryCount: 0,
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // SPECIFICATION PHASE
    // ───────────────────────────────────────────────────────
    specDraft: {
      on: {
        REQUEST_SPEC: {
          target: "specReview",
          actions: assign({
            status: "approved",
            stage: "spec",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    specReview: {
      on: {
        APPROVE_SPEC: {
          target: "executionGate",
          actions: assign({
            status: "approved",
            stage: "spec",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REQUEST_SPEC: {
          target: "specDraft",
          actions: assign({
            status: "approved",
            stage: "spec",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        REJECT: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "council",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // EXECUTION GATE PHASE
    // ───────────────────────────────────────────────────────
    executionGate: {
      on: {
        EXECUTION_GATE_PASS: {
          target: "executing",
          actions: assign({
            status: "controlled",
            stage: "execution-gate",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        EXECUTION_GATE_FAIL: {
          target: "rejected",
          actions: assign({
            status: "rejected",
            stage: "execution-gate",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // EXECUTION PHASE
    // ───────────────────────────────────────────────────────
    executing: {
      on: {
        EXECUTION_SUCCESS: {
          target: "postmortem",
          actions: assign({
            status: "executed",
            stage: "postmortem",
            retryCount: 0,
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
        EXECUTION_FAILED: {
          target: "executionError",
          actions: assign({
            errorMessage: "Execution failed",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    executionError: {
      on: {
        RETRY: [
          {
            target: "executing",
            guard: ({ context }) => context.retryCount < 3,
            actions: assign({
              retryCount: ({ context }) => context.retryCount + 1,
              lastTransitionTime: () => new Date().toISOString(),
            }),
          },
        ],
        EXECUTION_FAILED: {
          target: "postmortem",
          actions: assign({
            status: "failed",
            stage: "postmortem",
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // POSTMORTEM PHASE
    // ───────────────────────────────────────────────────────
    postmortem: {
      on: {
        POSTMORTEM: {
          target: "completed",
          actions: assign({
            lastTransitionTime: () => new Date().toISOString(),
          }),
        },
      },
    },

    // ───────────────────────────────────────────────────────
    // TERMINAL STATES
    // ───────────────────────────────────────────────────────
    rejected: {
      type: "final",
    },

    completed: {
      type: "final",
    },
  },
});

export type ProposalMachine = typeof proposalMachine;
