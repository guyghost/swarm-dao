// Contract tests for the ship-audit machine (RED first: written against the
// approved model before implementation — models/ship-audit.md, hash
// 482756e9ce256bc7c4439dc22020577e0c22c8c34b7cd083dc893456e4158ad3).
import { describe, expect, test } from "bun:test";
import {
  computeShipAuditDecision,
  createShipAuditActor,
  freshShipAuditContext,
  SHIP_AUDIT_TERMINAL_STATES,
} from "../src/models/ship-audit.machine.js";

const systemRequest = (fingerprint: string) =>
  ({ type: "SHIP_REQUESTED", source: "system", fingerprint, occurredAt: "2031-01-01T00:00:00.000Z" }) as const;

describe("ship-audit machine — nominal transitions", () => {
  test("N2: first ship request challenges and records the fingerprint", () => {
    const actor = createShipAuditActor(7);
    actor.send(systemRequest("fp-1"));
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("challenged");
    expect(snap.context.fingerprint).toBe("fp-1");
    expect(snap.context.challengeCount).toBe(1);
  });

  test("N3: identical second request confirms", () => {
    const actor = createShipAuditActor(7);
    actor.send(systemRequest("fp-1"));
    actor.send(systemRequest("fp-1"));
    expect(actor.getSnapshot().value).toBe("confirmed");
  });

  test("N4: changed fingerprint re-challenges and voids the prior audit", () => {
    const actor = createShipAuditActor(7);
    actor.send(systemRequest("fp-1"));
    actor.send(systemRequest("fp-2"));
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("challenged");
    expect(snap.context.fingerprint).toBe("fp-2");
    expect(snap.context.challengeCount).toBe(2);
  });

  test("N5: SHIP_CONSUMED resets the cycle to fresh", () => {
    const actor = createShipAuditActor(7);
    actor.send(systemRequest("fp-1"));
    actor.send(systemRequest("fp-1"));
    actor.send({ type: "SHIP_CONSUMED", source: "system", occurredAt: "2031-01-01T00:00:01.000Z" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("fresh");
    // A new cycle challenges again from scratch.
    actor.send(systemRequest("fp-1"));
    expect(actor.getSnapshot().value).toBe("challenged");
  });

  test("N6: human FORCE_OVERRIDE bypasses from challenged", () => {
    const actor = createShipAuditActor(7);
    actor.send(systemRequest("fp-1"));
    actor.send({ type: "FORCE_OVERRIDE", source: "human", reason: "hotfix", occurredAt: "2031-01-01T00:00:02.000Z" });
    expect(actor.getSnapshot().value).toBe("bypassed");
    expect(actor.getSnapshot().status).toBe("done");
  });
});

describe("ship-audit machine — permissions and immutability", () => {
  test("P1: SHIP_REQUESTED from ai or human is rejected", () => {
    for (const source of ["ai", "human"] as const) {
      const actor = createShipAuditActor(1);
      actor.send({ ...systemRequest("fp"), source });
      expect(actor.getSnapshot().value).toBe("fresh");
    }
  });

  test("P2: FORCE_OVERRIDE and CANCEL from ai or system are rejected", () => {
    for (const source of ["ai", "system"] as const) {
      const actor = createShipAuditActor(1);
      actor.send(systemRequest("fp"));
      actor.send({ type: "FORCE_OVERRIDE", source, reason: "x", occurredAt: "2031-01-01T00:00:00.000Z" });
      expect(actor.getSnapshot().value).toBe("challenged");
      actor.send({ type: "CANCEL", source, reason: "x", occurredAt: "2031-01-01T00:00:00.000Z" });
      expect(actor.getSnapshot().value).toBe("challenged");
    }
  });

  test("P3: terminal states accept no events", () => {
    const actor = createShipAuditActor(1);
    actor.send(systemRequest("fp"));
    actor.send({ type: "CANCEL", source: "human", reason: "stop", occurredAt: "2031-01-01T00:00:00.000Z" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    actor.send(systemRequest("fp"));
    actor.send({ type: "SHIP_CONSUMED", source: "system", occurredAt: "2031-01-01T00:00:00.000Z" });
    actor.send({ type: "FORCE_OVERRIDE", source: "human", reason: "x", occurredAt: "2031-01-01T00:00:00.000Z" });
    expect(actor.getSnapshot().value).toBe("cancelled");
  });

  test("P4: SHIP_CONSUMED is only valid from confirmed", () => {
    for (const setup of ["fresh", "challenged"] as const) {
      const actor = createShipAuditActor(1);
      if (setup === "challenged") actor.send(systemRequest("fp"));
      actor.send({ type: "SHIP_CONSUMED", source: "system", occurredAt: "2031-01-01T00:00:00.000Z" });
      expect(actor.getSnapshot().value).toBe(setup);
    }
  });

  test("terminal states list matches the model", () => {
    expect([...SHIP_AUDIT_TERMINAL_STATES].sort()).toEqual(["bypassed", "cancelled"]);
  });
});

describe("ship-audit decision helper", () => {
  test("the handler decision is derived from the resulting state", () => {
    expect(computeShipAuditDecision("challenged")).toBe("AUDIT_REQUIRED");
    expect(computeShipAuditDecision("confirmed")).toBe("PROCEED");
    expect(computeShipAuditDecision("bypassed")).toBe("PROCEED");
    expect(computeShipAuditDecision("fresh")).toBe("AUDIT_REQUIRED");
    expect(computeShipAuditDecision("cancelled")).toBe("BLOCKED");
  });

  test("fresh context carries the immutable correlation id", () => {
    const context = freshShipAuditContext(42);
    expect(context.proposalId).toBe(42);
    expect(context.fingerprint).toBeNull();
    expect(context.challengeCount).toBe(0);
  });
});
