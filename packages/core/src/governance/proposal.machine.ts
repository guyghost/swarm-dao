// ============================================================
// Swarm DAO Core — Proposal Lifecycle State Machine
// ------------------------------------------------------------
// Single source of truth for proposal status transitions.
//
// Discipline: "Le modèle décide." The LLM (council/votes) produces
// signals (a TallyResult, a ControlCheckResult). Those signals are
// carried as event payloads and evaluated by guards. No call site
// chooses a target status — it only emits the event that matches
// what happened in the world. The machine owns every edge.
//
// The 7 machine states map 1:1 to `ProposalStatus`. There is no
// hidden `executing`/`postmortem` pipeline: the runtime is
// synchronous (deliberation is one tool call, execution is one
// tool call), so those intermediate states had no observer and
// were removed during distill.
// ============================================================

import { assign, setup } from "xstate";
import type { ControlCheckResult, Proposal, ProposalStatus, TallyResult } from "../types/index.js";

// ── Context & Events ─────────────────────────────────────────

export interface ProposalContext {
  proposal: Proposal;
  errorMessage?: string;
  lastTransitionTime: string;
}

export interface ProposalMachineInput {
  proposal: Proposal;
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

// ── Terminal statuses ────────────────────────────────────────

export const PROPOSAL_FINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set(["executed", "failed", "rejected"]);

export function isProposalFinal(status: ProposalStatus): boolean {
  return PROPOSAL_FINAL_STATUSES.has(status);
}

// ── Machine ──────────────────────────────────────────────────
//
// Guards are the two real permission boundaries of the DAO:
//   • tallyApproved  — the council's vote authorized approval.
//   • gatesPassed    — quality control cleared the proposal for execution.
//
// Risk-zone / mandatory-dry-run is enforced upstream by the
// `mandatory-dry-run` control gate (control/gates.ts), which makes
// `ControlCheckResult.allGatesPassed` false for red-zone proposals
// without a dry-run. Duplicating that check here would be unearned
// complexity — the invariant already lives at the control boundary.

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
});

function buildProposalMachine(initial: ProposalStatus) {
  return proposalSetup.createMachine({
    id: "proposalLifecycle",
    initial,
    context: ({ input }) => ({
      proposal: input.proposal,
      lastTransitionTime: input.lastTransitionTime ?? new Date().toISOString(),
    }),

    // Note on the escape hatches (DISCARD / ERROR): they are inlined
    // into every non-terminal state rather than declared at the root
    // `on:`. XState v5 does not resolve root-level `on:` targets that
    // reference top-level child states — it reads them as relative to
    // the root's (non-existent) parent and rejects the machine. Final
    // states (`executed`, `failed`, `rejected`) are `type: "final"`
    // and ignore events once the machine is done, so the hatches are
    // intentionally absent there.
    states: {
      open: {
        on: {
          DELIBERATE: {
            target: "deliberating",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          DISCARD: {
            target: "rejected",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },

      deliberating: {
        on: {
          APPROVE: {
            target: "approved",
            guard: "tallyApproved",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          REJECT: {
            target: "rejected",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          DISCARD: {
            target: "rejected",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },

      approved: {
        on: {
          CONTROL_PASS: {
            target: "controlled",
            guard: "gatesPassed",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          CONTROL_FAIL: {
            target: "failed",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          REJECT: {
            target: "rejected",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          FAIL: {
            target: "failed",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          DISCARD: {
            target: "rejected",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },

      controlled: {
        on: {
          EXECUTE_SUCCESS: {
            target: "executed",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          FAIL: {
            target: "failed",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          DISCARD: {
            target: "rejected",
            actions: assign({ lastTransitionTime: () => new Date().toISOString() }),
          },
          ERROR: {
            target: "failed",
            actions: assign({
              lastTransitionTime: () => new Date().toISOString(),
              errorMessage: ({ event }) => (event.type === "ERROR" ? event.message : ""),
            }),
          },
        },
      },

      executed: { type: "final" },
      failed: { type: "final" },
      rejected: { type: "final" },
    },
  });
}

// ── Factory (with memoization) ───────────────────────────────
//
// A machine is created per starting status so an actor can be
// rehydrated at the persisted status of a proposal. The machine
// definition is identical; only `initial` differs.

const machineCache = new Map<ProposalStatus, ReturnType<typeof buildProposalMachine>>();

export function createProposalMachine(initial: ProposalStatus) {
  let machine = machineCache.get(initial);
  if (!machine) {
    machine = buildProposalMachine(initial);
    machineCache.set(initial, machine);
  }
  return machine;
}

export type ProposalMachine = ReturnType<typeof buildProposalMachine>;
