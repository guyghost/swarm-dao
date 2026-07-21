import { describe, expect, it } from "bun:test";
import { createActor } from "xstate";
import {
  arbitratePairedSignals,
  assertFrozenSetIntact,
  IMPROVEMENT_TERMINAL_STATES,
  improvementMachine,
  REQUIRED_IMPROVEMENT_ANCHORS,
} from "../src/models/improvement-loop.machine.js";

type AnyActor = ReturnType<typeof createActor<typeof improvementMachine>>;

const startActor = (referenceHash = "ref-a") => {
  const actor = createActor(improvementMachine, { input: { cycleId: "regression", scope: "s", referenceHash } });
  actor.start();
  return actor;
};

const nominalSuccess = (actor: AnyActor) => {
  actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
  actor.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
  actor.send({ type: "SAMPLES_SEALED", source: "tool" });
  actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
  actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
  for (const a of REQUIRED_IMPROVEMENT_ANCHORS) {
    const auto = a === "counter-metric-paired" || a === "arbitration-policy";
    if (auto) continue;
    actor.send({ type: "ANCHOR_RECORDED", source: "tool", anchor: a, status: "passed", evidence: `${a}-ok` });
  }
  actor.send({ type: "EVALUATE", source: "system" });
};

describe("improvement-loop — architectural regression invariants", () => {
  it("the model lists exactly the six required ground-contact anchors", () => {
    expect([...REQUIRED_IMPROVEMENT_ANCHORS]).toEqual([
      "counter-metric-paired",
      "drift-audit",
      "arbitration-policy",
      "anchor-reality",
      "frozen-set-intact",
      "regression",
    ]);
  });

  it("the only declared terminal states are explicit honest outcomes", () => {
    expect([...IMPROVEMENT_TERMINAL_STATES]).toEqual(["succeeded", "failed", "blocked", "cancelled"]);
  });

  it("AI can never drive the cycle to success on its own", () => {
    const actor = startActor();
    // AI attempts every event type it might "want" to emit
    actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
    actor.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
    actor.send({ type: "SAMPLES_SEALED", source: "ai" }); // rejected: must be tool
    expect(actor.getSnapshot().value).toBe("sampling");
    actor.send({ type: "ARBITRATION", source: "ai", outcome: "balanced" }); // rejected
    actor.send({ type: "EVALUATE", source: "ai" }); // rejected
    for (const a of REQUIRED_IMPROVEMENT_ANCHORS) {
      actor.send({ type: "ANCHOR_RECORDED", source: "ai", anchor: a, status: "passed", evidence: "ai-says-pass" });
    }
    // still in sampling: AI produced signals but no transitions
    expect(actor.getSnapshot().value).toBe("sampling");
  });

  it("self-approved reference changes are impossible (human + exact hash required)", () => {
    const actor = startActor("ref-x");
    actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
    actor.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
    actor.send({ type: "SAMPLES_SEALED", source: "tool" });
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "detached" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    for (const a of REQUIRED_IMPROVEMENT_ANCHORS) {
      const auto = a === "counter-metric-paired" || a === "arbitration-policy";
      if (auto) continue;
      actor.send({ type: "ANCHOR_RECORDED", source: "tool", anchor: a, status: "passed", evidence: `${a}-ok` });
    }
    actor.send({ type: "EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("adjusting");

    // AI self-approval attempts all rejected
    actor.send({ type: "REFERENCE_CHANGE_APPROVED", source: "ai", referenceHash: "ref-x" });
    actor.send({ type: "REFERENCE_CHANGE_APPROVED", source: "ai", referenceHash: "ref-y" });
    // human must approve the EXACT recorded reference, not a free-form one
    actor.send({ type: "REFERENCE_CHANGE_APPROVED", source: "human", referenceHash: "ref-y" });
    expect(actor.getSnapshot().value).toBe("adjusting");

    // only the exact match resets the cycle
    actor.send({ type: "REFERENCE_CHANGE_APPROVED", source: "human", referenceHash: "ref-x" });
    expect(actor.getSnapshot().value).toBe("sampling");
  });

  it("a failed frozen-set-intact cannot be unfrozen without a human reference change", () => {
    const actor = startActor();
    actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
    actor.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
    actor.send({ type: "SAMPLES_SEALED", source: "tool" });
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "frozen-set-intact",
      status: "failed",
      evidence: "drift",
    });
    for (const a of REQUIRED_IMPROVEMENT_ANCHORS) {
      const skip = a === "counter-metric-paired" || a === "arbitration-policy" || a === "frozen-set-intact";
      if (skip) continue;
      actor.send({ type: "ANCHOR_RECORDED", source: "tool", anchor: a, status: "passed", evidence: `${a}-ok` });
    }
    actor.send({ type: "EVALUATE", source: "system" });
    // failed frozen-set blocks success -> retrying, never succeeded
    expect(actor.getSnapshot().value).toBe("retrying");

    // AI cannot re-mark the frozen set as passed on retry (anchor survives, recordAnchorOnce no-ops)
    actor.send({ type: "RETRY_AUTHORIZED", source: "human" });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "ai",
      anchor: "frozen-set-intact",
      status: "passed",
      evidence: "ai-fixes",
    });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "frozen-set-intact",
      status: "passed",
      evidence: "tool-fixes",
    });
    expect(actor.getSnapshot().context.anchors["frozen-set-intact"]?.status).toBe("failed");
  });

  it("arbitration outcome is produced by the model, never supplied by the AI", () => {
    // Deterministic function decides; identical paired signals always yield one outcome.
    const det = arbitratePairedSignals({ value: "rose", evidence: "m" }, { value: "declined", evidence: "c" });
    expect(det.arbitrationPolicyPassed).toBe(false);
    // The machine only accepts tool-source ARBITRATION; an ai-supplied outcome is dropped.
    const actor = startActor();
    actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
    actor.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
    actor.send({ type: "SAMPLES_SEALED", source: "tool" });
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
    const aiOutcome = arbitratePairedSignals(
      { value: "rose", evidence: "m" },
      { value: "declined", evidence: "c" },
    ).outcome;
    actor.send({ type: "ARBITRATION", source: "ai", outcome: aiOutcome });
    expect(actor.getSnapshot().value).toBe("arbitrating");
    expect(actor.getSnapshot().context.arbitrationOutcome).toBeNull();
  });

  it("frozen-set integrity is a pure equality check, not a negotiation", () => {
    expect(assertFrozenSetIntact("h1", "h1")).toBe(true);
    expect(assertFrozenSetIntact("h1", "h2")).toBe(false);
  });

  it("every honest terminal state is reachable from the model", () => {
    // succeeded
    const ok = startActor();
    nominalSuccess(ok);
    expect(ok.getSnapshot().value).toBe("succeeded");

    // failed: exhaust retries with no anchors
    const fail = startActor();
    fail.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
    fail.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
    fail.send({ type: "SAMPLES_SEALED", source: "tool" });
    fail.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
    fail.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    for (let i = 0; i <= 2; i++) {
      fail.send({ type: "EVALUATE", source: "system" });
      if (fail.getSnapshot().value === "retrying") {
        fail.send({ type: "RETRY_AUTHORIZED", source: "human" });
        fail.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
        fail.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
        fail.send({ type: "SAMPLES_SEALED", source: "tool" });
        fail.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
        fail.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
      }
    }
    expect(fail.getSnapshot().value).toBe("failed");

    // blocked
    const blocked = startActor();
    blocked.send({ type: "PERMISSION_DENIED", source: "tool", reason: "unauthorized" });
    expect(blocked.getSnapshot().value).toBe("blocked");

    // cancelled
    const cancelled = startActor();
    cancelled.send({ type: "CANCEL", source: "human", reason: "halt" });
    expect(cancelled.getSnapshot().value).toBe("cancelled");
  });
});
