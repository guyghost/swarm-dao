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
import {
  createProposalMachine,
  isProposalFinal,
  type ProposalEvent,
  type ProposalMachineInput,
} from "../models/proposal.machine.js";
import type { ClockPort } from "../ports/clock.js";
import { systemClock } from "../ports/clock.js";
import type { Proposal, ProposalStatus } from "../types/index.js";

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
  options: { clock?: ClockPort } = {},
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
  const machine = createProposalMachine(proposal.status);
  const actor = createActor(machine, {
    input: {
      proposal,
      transitionTime,
      lastTransitionTime: transitionTime,
    } satisfies ProposalMachineInput,
  });
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

  return { ok: true, status };
}
