import { assign, setup } from "xstate";
import type { ControlCheckResult, Proposal, ProposalStatus, TallyResult } from "../types/index.js";

export interface ProposalContext {
  proposal: Proposal;
  errorMessage?: string;
  lastTransitionTime: string;
  transitionTime: string;
}

export interface ProposalMachineInput {
  proposal: Proposal;
  transitionTime: string;
  lastTransitionTime?: string;
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

export const PROPOSAL_FINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set(["executed", "failed", "rejected"]);

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
    tallyApproved: ({ event }) => event.type === "APPROVE" && event.tally.approved === true,
    gatesPassed: ({ event }) =>
      event.type === "CONTROL_PASS" && event.result.allGatesPassed === true && event.result.blockerCount === 0,
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
      failed: { type: "final" },
      rejected: { type: "final" },
    },
  });
}
