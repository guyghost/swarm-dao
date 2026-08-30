// ============================================================
// Swarm DAO Core — Ship Audit Challenge Machine (pure)
// ============================================================
// swarm-forge's AUDIT_REQUIRED adapted to proposal shipping: when enabled,
// the first ship call challenges instead of executing; only an unchanged
// second call confirms. Any change to the decision re-challenges. There is
// deliberately no AI role — confirmation is a deterministic property of two
// identical requests (INV-3).
//
// Authority boundary (models/ship-audit.md): this machine owns only a
// proposal's audit-challenge state. It never mutates proposal state, never
// emits proposal events (proposalStateAuthority: "none"), and performs no
// I/O — fingerprints and timestamps arrive as event payloads.

import { type ActorRefFrom, assign, createActor, setup } from "xstate";

export const SHIP_AUDIT_TERMINAL_STATES = ["bypassed", "cancelled"] as const;

export type ShipAuditState = "fresh" | "challenged" | "confirmed" | (typeof SHIP_AUDIT_TERMINAL_STATES)[number];

export type ShipAuditEvent =
  | { type: "SHIP_REQUESTED"; source: "system"; fingerprint: string; occurredAt: string }
  | { type: "SHIP_CONSUMED"; source: "system"; occurredAt: string }
  | { type: "FORCE_OVERRIDE"; source: "human"; reason: string; occurredAt: string }
  | { type: "CANCEL"; source: "human"; reason: string; occurredAt: string };

export interface ShipAuditContext {
  /** Immutable correlation — grants no proposal-state permission (INV-4). */
  proposalId: number;
  /** Fingerprint at challenge time; null outside a challenge cycle. */
  fingerprint: string | null;
  /** Cumulative challenges issued (observability; cycles do not reset it). */
  challengeCount: number;
  confirmedAt: string | null;
  terminalReason: string | null;
}

export const freshShipAuditContext = (proposalId: number): ShipAuditContext => ({
  proposalId,
  fingerprint: null,
  challengeCount: 0,
  confirmedAt: null,
  terminalReason: null,
});

/** What the deterministic ship handler must do for a given audit state. */
export function computeShipAuditDecision(state: ShipAuditState): "PROCEED" | "AUDIT_REQUIRED" | "BLOCKED" {
  if (state === "confirmed" || state === "bypassed") return "PROCEED";
  if (state === "cancelled") return "BLOCKED";
  return "AUDIT_REQUIRED";
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

export const shipAuditMachine = setup({
  types: {
    context: {} as ShipAuditContext,
    events: {} as ShipAuditEvent,
    input: {} as { proposalId: number },
  },
  guards: {
    isSystemShipRequest: ({ event }) => event.type === "SHIP_REQUESTED" && event.source === "system",
    isSystemConsume: ({ event }) => event.type === "SHIP_CONSUMED" && event.source === "system",
    isHumanForce: ({ event }) => event.type === "FORCE_OVERRIDE" && event.source === "human" && nonEmpty(event.reason),
    isHumanCancel: ({ event }) => event.type === "CANCEL" && event.source === "human" && nonEmpty(event.reason),
    isSystemRequestMatchingFingerprint: ({ event, context }) =>
      event.type === "SHIP_REQUESTED" && event.source === "system" && context.fingerprint === event.fingerprint,
    isSystemRequestChangingFingerprint: ({ event, context }) =>
      event.type === "SHIP_REQUESTED" && event.source === "system" && context.fingerprint !== event.fingerprint,
  },
  actions: {
    recordChallenge: assign(({ event, context }) => ({
      fingerprint: event.type === "SHIP_REQUESTED" ? event.fingerprint : context.fingerprint,
      challengeCount: context.challengeCount + 1,
      confirmedAt: null,
    })),
    recordConfirmation: assign(({ event }) => ({
      confirmedAt: event.type === "SHIP_REQUESTED" ? event.occurredAt : null,
    })),
    consumeConfirmation: assign(() => ({
      fingerprint: null,
      confirmedAt: null,
    })),
    recordBypass: assign(({ event }) => ({
      terminalReason: event.type === "FORCE_OVERRIDE" ? `force override: ${event.reason}` : null,
    })),
    recordCancellation: assign(({ event }) => ({
      terminalReason: event.type === "CANCEL" ? `cancelled: ${event.reason}` : null,
    })),
  },
}).createMachine({
  id: "ship-audit",
  initial: "fresh",
  context: ({ input }) => freshShipAuditContext(input.proposalId),
  on: {
    CANCEL: { guard: "isHumanCancel", target: ".cancelled", actions: "recordCancellation" },
  },
  states: {
    fresh: {
      on: {
        SHIP_REQUESTED: { guard: "isSystemShipRequest", target: "challenged", actions: "recordChallenge" },
        FORCE_OVERRIDE: { guard: "isHumanForce", target: "bypassed", actions: "recordBypass" },
      },
    },
    challenged: {
      on: {
        SHIP_REQUESTED: [
          // INV-2: only the exact challenged fingerprint confirms.
          {
            guard: "isSystemRequestMatchingFingerprint",
            target: "confirmed",
            actions: "recordConfirmation",
          },
          // A changed decision voids the audit and re-challenges.
          { guard: "isSystemRequestChangingFingerprint", target: "challenged", actions: "recordChallenge" },
        ],
        FORCE_OVERRIDE: { guard: "isHumanForce", target: "bypassed", actions: "recordBypass" },
      },
    },
    confirmed: {
      on: {
        // A matching re-request stays confirmed so the handler can proceed;
        // the single spend happens via SHIP_CONSUMED (INV-6).
        SHIP_REQUESTED: { guard: "isSystemRequestMatchingFingerprint", target: "confirmed" },
        SHIP_CONSUMED: { guard: "isSystemConsume", target: "fresh", actions: "consumeConfirmation" },
        FORCE_OVERRIDE: { guard: "isHumanForce", target: "bypassed", actions: "recordBypass" },
      },
    },
    bypassed: { type: "final" },
    cancelled: { type: "final" },
  },
});

export type ShipAuditActor = ActorRefFrom<typeof shipAuditMachine>;

export const createShipAuditActor = (proposalId: number): ShipAuditActor => {
  const actor = createActor(shipAuditMachine, { input: { proposalId } });
  actor.start();
  return actor;
};
