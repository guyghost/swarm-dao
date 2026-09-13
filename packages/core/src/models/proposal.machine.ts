import { assign, setup } from "xstate";
import type { ControlCheckResult, Proposal, ProposalStatus, TallyResult } from "../types/index.js";

export interface ProposalContext {
  proposal: Proposal;
  errorMessage?: string;
  lastTransitionTime: string;
  transitionTime: string;
  /** Recomputed guard decisions (issue #158), populated from machine input. */
  expectedApprove?: boolean;
  expectedGatesPass?: boolean;
}

export interface ProposalMachineInput {
  proposal: Proposal;
  transitionTime: string;
  lastTransitionTime?: string;
  /** Recomputed by dispatchProposalEvent from live proposal state — guards
   *  never trust the event payload (issue #158). */
  expectedApprove?: boolean;
  expectedGatesPass?: boolean;
}

export type ProposalEvent =
  | { type: "DELIBERATE" }
  | { type: "APPROVE"; tally: TallyResult }
  | { type: "REJECT" }
  | { type: "CONTROL_PASS"; result: ControlCheckResult }
  | { type: "CONTROL_FAIL" }
  | { type: "EXECUTE_SUCCESS" }
  | { type: "FAIL" }
  | { type: "DISCARD" }
  | { type: "ERROR"; message: string };

// `failed` is deliberately NOT final (issue #141): a gate failure is by
// definition recoverable, and a dead proposal must stay annotatable — the
// machine gives `failed` exactly one transition (REJECT → rejected) so the
// closure reason is auditable while no lifecycle reuse is possible.
export const PROPOSAL_FINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set(["executed", "rejected"]);

export function isProposalFinal(status: ProposalStatus): boolean {
  return PROPOSAL_FINAL_STATUSES.has(status);
}

const proposalSetup = setup({
  types: {
    context: {} as ProposalContext,
    input: {} as ProposalMachineInput,
    events: {} as ProposalEvent,
  },
  guards: {
    // Decision guards recompute from context (populated by
    // dispatchProposalEvent from the proposal's actual votes / gate replay),
    // never from the tally/result carried by the event (issue #158).
    tallyApproved: ({ context }) => context.expectedApprove === true,
    gatesPassed: ({ context }) => context.expectedGatesPass === true,
  },
  actions: {
    recordTransition: assign({ lastTransitionTime: ({ context }) => context.transitionTime }),
    recordError: assign({
      lastTransitionTime: ({ context }) => context.transitionTime,
      errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
    }),
  },
});

const escapeHatches = {
  DISCARD: { target: "rejected", actions: "recordTransition" },
  ERROR: { target: "failed", actions: "recordError" },
} as const;

export function createProposalMachine(initial: ProposalStatus = "open") {
  return proposalSetup.createMachine({
    id: "proposalLifecycle",
    initial,
    context: ({ input }) => ({
      proposal: input.proposal,
      transitionTime: input.transitionTime,
      lastTransitionTime: input.lastTransitionTime ?? input.transitionTime,
      expectedApprove: input.expectedApprove,
      expectedGatesPass: input.expectedGatesPass,
    }),
    states: {
      open: { on: { DELIBERATE: { target: "deliberating", actions: "recordTransition" }, ...escapeHatches } },
      deliberating: {
        on: {
          APPROVE: { target: "approved", guard: "tallyApproved", actions: "recordTransition" },
          REJECT: { target: "rejected", actions: "recordTransition" },
          ...escapeHatches,
        },
      },
      approved: {
        on: {
          CONTROL_PASS: { target: "controlled", guard: "gatesPassed", actions: "recordTransition" },
          CONTROL_FAIL: { target: "failed", actions: "recordTransition" },
          REJECT: { target: "rejected", actions: "recordTransition" },
          FAIL: { target: "failed", actions: "recordTransition" },
          ...escapeHatches,
        },
      },
      controlled: {
        on: {
          EXECUTE_SUCCESS: { target: "executed", actions: "recordTransition" },
          FAIL: { target: "failed", actions: "recordTransition" },
          ...escapeHatches,
        },
      },
      executed: { type: "final" },
      // `failed` is lifecycle-final (see PROPOSAL_FINAL_STATUSES) but keeps
      // one closure transition: REJECT records an auditable reason on a dead
      // proposal instead of leaving an unannotatable zombie (issue #141).
      failed: { on: { REJECT: { target: "rejected", actions: "recordTransition" } } },
      rejected: { type: "final" },
    },
  });
}
