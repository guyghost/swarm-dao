// ============================================================
// Swarm DAO Core — Proposal Dispatch Service
// ------------------------------------------------------------
// The only sanctioned way to mutate `proposal.status`. Every
// runtime path (host-tools, execution, pi/opencode adapters) goes
// through `dispatchProposalEvent`: it rehydrates an actor at the
// proposal's persisted status, asks the machine whether the event
// is permitted (guards included), and only then writes the new
// status back to the proposal. There is no other status writer.
// ============================================================

import { createActor } from "xstate";
import { runGates } from "../control/gates.js";
import { type Electorate, tallyVotes } from "../governance/voting.js";
import {
  createProposalMachine,
  isProposalFinal,
  type ProposalEvent,
  type ProposalMachineInput,
} from "../models/proposal.machine.js";
import type { ClockPort } from "../ports/clock.js";
import { systemClock } from "../ports/clock.js";
import type { DAOConfig, Proposal, ProposalStatus } from "../types/index.js";

export type DispatchResult = { ok: true; status: ProposalStatus } | { ok: false; error: string };

/**
 * Apply a lifecycle event to a proposal. Enforces the machine's
 * topology AND its guards. On success, `proposal.status` (and
 * `proposal.resolvedAt` for terminal states) is updated in place.
 *
 * Returns `{ ok: false, error }` when the event is not permitted
 * from the current status — the caller must surface that error and
 * MUST NOT mutate the status itself.
 */
export function dispatchProposalEvent(
  proposal: Proposal,
  event: ProposalEvent,
  options: {
    clock?: ClockPort;
    /** Required for guarded events (APPROVE, CONTROL_PASS): the guard
     *  decision is recomputed from the proposal's real votes/gates, the
     *  event payload is never trusted (issue #158). */
    config?: DAOConfig;
    electorate?: Electorate;
    allProposals?: readonly Proposal[];
  } = {},
): DispatchResult {
  // Terminal states are final: no event may leave them. This guard
  // makes the invariant explicit rather than relying on the actor's
  // "done" status, so the model stays correct regardless of how the
  // XState runtime treats root-level global transitions once done.
  if (isProposalFinal(proposal.status)) {
    return {
      ok: false,
      error: `Proposal is in terminal status "${proposal.status}"; no transitions are permitted.`,
    };
  }

  const transitionTime = (options.clock ?? systemClock).now();

  const machineInput: ProposalMachineInput = {
    proposal,
    transitionTime,
    lastTransitionTime: transitionTime,
  };
  if (event.type === "APPROVE") {
    if (!options.config) {
      return {
        ok: false,
        error: 'Event "APPROVE" requires config so the tally can be recomputed from the proposal\'s votes.',
      };
    }
    machineInput.expectedApprove = tallyVotes(proposal, options.config, options.electorate).approved;
  } else if (event.type === "CONTROL_PASS") {
    if (!options.config) {
      return {
        ok: false,
        error: 'Event "CONTROL_PASS" requires config so the gates can be replayed against the proposal.',
      };
    }
    const replay = runGates(proposal, options.config, { allProposals: options.allProposals });
    machineInput.expectedGatesPass = replay.allGatesPassed && replay.blockerCount === 0;
  }

  const machine = createProposalMachine(proposal.status);
  const actor = createActor(machine, { input: machineInput });
  actor.start();

  const before = actor.getSnapshot();
  if (!before.can(event)) {
    return {
      ok: false,
      error: `Event "${event.type}" is not permitted from status "${proposal.status}".`,
    };
  }

  actor.send(event);
  const status = actor.getSnapshot().value as ProposalStatus;

  proposal.status = status;
  if (isProposalFinal(status) && !proposal.resolvedAt) {
    proposal.resolvedAt = transitionTime;
  }
  // Track deliberation start so stalled deliberations (dead worker/host)
  // can be detected and aborted instead of staying invisible (issue #160).
  if (status === "deliberating") {
    proposal.deliberationStartedAt = transitionTime;
  }

  return { ok: true, status };
}
