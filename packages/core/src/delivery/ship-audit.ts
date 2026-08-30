// ============================================================
// Swarm DAO Core — Ship Audit Delivery (fingerprint + gate)
// ============================================================
// Deterministic glue between the ship handler and the audit machine:
// - computeShipFingerprint: canonical sha256 over the proposal's
//   decision-relevant content (anything that changes the decision must
//   re-challenge — INV-2). Uses node:crypto; lives OUTSIDE src/models to
//   respect the models purity contract.
// - evaluateShipAuditChallenge: the gate the handler consults before
//   ShipProposalUseCase. Never mutates proposal state. The challenge binds
//   the decision fingerprint AND the ship options (cascade): changing the
//   operation between challenge and confirmation re-issues the challenge.
//   The read→transition→write sequence runs under an exclusive cross-process
//   claim, so one confirmation can never authorize concurrent ships (INV-6).

import { createHash } from "node:crypto";
import {
  computeShipAuditDecision,
  createShipAuditActor,
  type ShipAuditActor,
  type ShipAuditState,
} from "../models/ship-audit.machine.js";
import type { ShipAuditSnapshot, ShipAuditStorePort } from "../ports/ship-audit.js";
import type { Proposal } from "../types/index.js";

/** Canonical decision-relevant content of a proposal. Pure data selection. */
function decisionContent(proposal: Proposal): Record<string, unknown> {
  const control = proposal.riskZone ? { riskZone: proposal.riskZone } : {};
  return {
    id: proposal.id,
    title: proposal.title,
    type: proposal.type,
    description: proposal.description,
    status: proposal.status,
    dependsOn: proposal.dependsOn ?? [],
    votes: (proposal.votes ?? []).map((vote) => ({
      agentId: vote.agentId,
      position: vote.position,
      weight: vote.weight,
    })),
    control,
  };
}

/** sha256 over canonical JSON of the decision content. Deterministic. */
export function computeShipFingerprint(proposal: Proposal): string {
  const canonical = JSON.stringify(decisionContent(proposal), null, 0);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The challenge binds the decision fingerprint plus the operation options:
 * a single-proposal command must not morph into a cascading execution (or
 * the reverse) under one confirmation.
 */
function requestSignature(fingerprint: string, options: { cascade?: boolean }): string {
  return createHash("sha256")
    .update(`${fingerprint}|${JSON.stringify({ cascade: options.cascade === true })}`)
    .digest("hex");
}

export interface ShipAuditGateOptions {
  cascade?: boolean;
}

export type ShipAuditGateResult =
  | { proceed: true; note?: string; consume?: () => Promise<void> }
  | { proceed: false; message: string };

const REQUEST = (fingerprint: string) =>
  ({ type: "SHIP_REQUESTED", source: "system", fingerprint, occurredAt: "1970-01-01T00:00:00.000Z" }) as const;

function snapshotOf(actor: ShipAuditActor, count: number): ShipAuditSnapshot {
  const snap = actor.getSnapshot();
  return {
    proposalId: snap.context.proposalId,
    state: String(snap.value),
    status: String(snap.status),
    context: { ...snap.context, challengeCount: count },
  };
}

/**
 * Rebuild a live actor from a persisted snapshot by deterministic replay:
 * challenged = one request with the persisted signature, confirmed = two.
 * Terminal contexts never block later cycles (review: cycle semantics) — a
 * new ship call on a still-controlled proposal starts fresh.
 */
function hydrate(persisted: ShipAuditSnapshot | null, proposalId: number): { actor: ShipAuditActor; count: number } {
  const count = persisted?.context.challengeCount ?? 0;
  const actor = createShipAuditActor(proposalId);
  const fingerprint = persisted?.context.fingerprint ?? null;
  if (!fingerprint) return { actor, count };
  if (persisted?.state === "challenged") {
    actor.send(REQUEST(fingerprint));
  } else if (persisted?.state === "confirmed") {
    actor.send(REQUEST(fingerprint));
    actor.send(REQUEST(fingerprint));
  }
  return { actor, count };
}

/**
 * The deterministic ship gate (models/ship-audit.md):
 * - challenge disabled → proceed unchanged (N1)
 * - force → human bypass, recorded (N6) — the record MUST persist, so a
 *   store failure blocks the bypass instead of silently losing evidence
 * - first call → AUDIT_REQUIRED, nothing executes (N2)
 * - unchanged call (same decision AND same options) → proceed, with a
 *   `consume()` that spends the single confirmation (N3, INV-6)
 * - changed decision or options → re-challenge (N4)
 * - concurrent gate for the same proposal → blocked while claimed (INV-6)
 */
export async function evaluateShipAuditChallenge(input: {
  proposal: Proposal;
  store: ShipAuditStorePort;
  challengeEnabled: boolean;
  force?: boolean;
  forceReason?: string;
  options?: ShipAuditGateOptions;
  occurredAt?: string;
}): Promise<ShipAuditGateResult> {
  if (!input.challengeEnabled) return { proceed: true };

  const claim = await input.store.claim(input.proposal.id);
  if (!claim.acquired) {
    return {
      proceed: false,
      message: `A concurrent ship gate for proposal #${input.proposal.id} is in flight; retry once it completes.`,
    };
  }
  try {
    return await gate(input);
  } finally {
    await claim.release();
  }
}

async function gate(input: {
  proposal: Proposal;
  store: ShipAuditStorePort;
  force?: boolean;
  forceReason?: string;
  options?: ShipAuditGateOptions;
  occurredAt?: string;
}): Promise<ShipAuditGateResult> {
  const persisted = await input.store.load(input.proposal.id).catch(() => null);
  const { actor, count } = hydrate(persisted, input.proposal.id);

  if (input.force) {
    actor.send({
      type: "FORCE_OVERRIDE",
      source: "human",
      reason: input.forceReason ?? "operator force",
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    });
    // A bypass is only as good as its record: fail closed if it cannot persist.
    await input.store.save(snapshotOf(actor, count));
    return { proceed: true, note: "ship audit bypassed by force (recorded)" };
  }

  const fingerprint = computeShipFingerprint(input.proposal);
  const signature = requestSignature(fingerprint, input.options ?? {});
  actor.send({ ...REQUEST(signature), occurredAt: input.occurredAt ?? new Date().toISOString() });
  // The historical challenge counter lives here (the actor's own counter is
  // per-cycle): a new challenge — first of a cycle or a re-challenge after a
  // changed decision or options — increments it; a confirmation does not.
  const stateAfterRequest = String(actor.getSnapshot().value);
  const liveCount = stateAfterRequest === "challenged" ? count + 1 : count;
  await input.store.save(snapshotOf(actor, liveCount));

  const decision = computeShipAuditDecision(actor.getSnapshot().value as ShipAuditState);
  if (decision === "PROCEED") {
    return {
      proceed: true,
      consume: async () => {
        actor.send({ type: "SHIP_CONSUMED", source: "system", occurredAt: new Date().toISOString() });
        await input.store.save(snapshotOf(actor, liveCount));
      },
    };
  }
  if (decision === "BLOCKED") {
    const state = String(actor.getSnapshot().value);
    return { proceed: false, message: `Ship audit context is ${state}; start a new audit cycle.` };
  }
  return {
    proceed: false,
    message: [
      `AUDIT_REQUIRED — ship challenge ${liveCount} for proposal #${input.proposal.id}.`,
      "The first call never executes. Re-read the proposal and the control results, then call dao_ship again unchanged — the same decision AND the same options (cascade).",
      `Fingerprint: ${fingerprint.slice(0, 12)}… — any change to the decision (votes, gates, scope) or the options re-issues the challenge.`,
    ].join("\n"),
  };
}
