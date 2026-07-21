import { describe, expect, it } from "bun:test";
import { createActor } from "xstate";
import {
  IMPROVEMENT_MAX_RETRIES,
  IMPROVEMENT_TERMINAL_STATES,
  improvementMachine,
  REQUIRED_IMPROVEMENT_ANCHORS,
} from "../src/models/improvement-loop.machine.js";

type AnyActor = ReturnType<typeof createActor<typeof improvementMachine>>;

const startActor = (cycleId = "cycle-test", referenceHash = "ref-a") => {
  const actor = createActor(improvementMachine, { input: { cycleId, scope: "test-scope", referenceHash } });
  actor.start();
  return actor;
};

const samplePair = (actor: AnyActor) => {
  actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "metric-evidence" } });
  actor.send({
    type: "COUNTER_SAMPLED",
    source: "ai",
    sample: { value: "rose", evidence: "counter-evidence" },
  });
};

const seal = (actor: AnyActor) => actor.send({ type: "SAMPLES_SEALED", source: "tool" });

const reachGrounding = () => {
  const actor = startActor();
  samplePair(actor);
  seal(actor);
  actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
  actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
  return actor;
};

/** Records every anchor that is NOT auto-set by seal/arbitrate. */
const passRemainingAnchors = (actor: AnyActor) => {
  for (const anchor of REQUIRED_IMPROVEMENT_ANCHORS) {
    const autoSet = anchor === "counter-metric-paired" || anchor === "arbitration-policy";
    if (autoSet) continue;
    actor.send({ type: "ANCHOR_RECORDED", source: "tool", anchor, status: "passed", evidence: `${anchor} exited 0` });
  }
};

describe("improvement-loop machine — transitions", () => {
  it("reaches succeeded only through the full nominal path", () => {
    const actor = reachGrounding();
    passRemainingAnchors(actor);
    actor.send({ type: "EVALUATE", source: "system" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("succeeded");
    expect(snapshot.context.metric?.value).toBe("rose");
    expect(snapshot.context.counterMetric?.value).toBe("rose");
    expect(Object.keys(snapshot.context.anchors).sort()).toEqual([...REQUIRED_IMPROVEMENT_ANCHORS].sort());
  });

  it("routes drift-detached to adjusting, never to succeeded", () => {
    const actor = startActor();
    samplePair(actor);
    seal(actor);
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "detached" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    passRemainingAnchors(actor);
    actor.send({ type: "EVALUATE", source: "system" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("adjusting");
    expect(snapshot.context.driftClass).toBe("detached");
  });

  it("EVALUATE decision order: detached takes precedence over all anchors passed", () => {
    const actor = startActor();
    samplePair(actor);
    seal(actor);
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "detached" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    passRemainingAnchors(actor);
    // all anchors passed AND drift detached -> must adjust, not succeed
    actor.send({ type: "EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("adjusting");
  });

  it("fails closed into retrying when an anchor is missing", () => {
    const actor = reachGrounding();
    // deliberately skip passRemainingAnchors
    actor.send({ type: "EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("retrying");
    expect(actor.getSnapshot().context.attempt).toBe(0);
  });

  it("moves to failed after retries are exhausted", () => {
    const actor = reachGrounding();
    for (let i = 0; i <= IMPROVEMENT_MAX_RETRIES; i++) {
      actor.send({ type: "EVALUATE", source: "system" });
      const retrying = actor.getSnapshot().value === "retrying";
      if (retrying) {
        actor.send({ type: "RETRY_AUTHORIZED", source: "human" });
        // re-seal the pair and re-arbitrate on the fresh attempt, but skip anchors again
        samplePair(actor);
        seal(actor);
        actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
        actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
      }
    }
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("does not seal samples before both are provided", () => {
    const actor = startActor();
    actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
    actor.send({ type: "SAMPLES_SEALED", source: "tool" });
    expect(actor.getSnapshot().value).toBe("sampling");
  });
});

describe("improvement-loop machine — authority boundaries", () => {
  it("rejects tool/system/ai sources for sampling that require ai", () => {
    const actor = startActor();
    actor.send({ type: "METRIC_SAMPLED", source: "tool", sample: { value: "rose", evidence: "m" } });
    expect(actor.getSnapshot().context.metric).toBeNull();
    actor.send({ type: "METRIC_SAMPLED", source: "system", sample: { value: "rose", evidence: "m" } });
    expect(actor.getSnapshot().context.metric).toBeNull();
  });

  it("rejects AI-emitted anchors, arbitrations, and evaluations", () => {
    const actor = reachGrounding();
    const before = { ...actor.getSnapshot().context.anchors };
    actor.send({ type: "ANCHOR_RECORDED", source: "ai", anchor: "regression", status: "passed", evidence: "ai-says" });
    expect(actor.getSnapshot().context.anchors).toEqual(before);
    actor.send({ type: "ARBITRATION", source: "ai", outcome: "balanced" });
    actor.send({ type: "EVALUATE", source: "ai" });
    expect(actor.getSnapshot().value).toBe("grounding");
  });

  it("rejects a human-claimed EVALUATE (only system evaluates)", () => {
    const actor = reachGrounding();
    passRemainingAnchors(actor);
    actor.send({ type: "EVALUATE", source: "human" });
    expect(actor.getSnapshot().value).toBe("grounding");
  });

  it("requires human authority and exact hash match for reference change", () => {
    const actor = startActor();
    samplePair(actor);
    seal(actor);
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "detached" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    passRemainingAnchors(actor);
    actor.send({ type: "EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("adjusting");

    // AI cannot self-approve a reference change
    actor.send({ type: "REFERENCE_CHANGE_APPROVED", source: "ai", referenceHash: "ref-b" });
    expect(actor.getSnapshot().value).toBe("adjusting");
    // human cannot approve a different hash than the recorded reference
    actor.send({ type: "REFERENCE_CHANGE_APPROVED", source: "human", referenceHash: "ref-c" });
    expect(actor.getSnapshot().value).toBe("adjusting");
    // human approving the exact recorded reference resets the cycle
    actor.send({ type: "REFERENCE_CHANGE_APPROVED", source: "human", referenceHash: "ref-a" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("sampling");
    expect(snap.context.approvedReferenceHash).toBe("ref-a");
    expect(snap.context.attempt).toBe(0);
    expect(snap.context.anchors).toEqual({});
  });

  it("requires human authority for retry authorization", () => {
    const actor = reachGrounding();
    actor.send({ type: "EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("retrying");
    actor.send({ type: "RETRY_AUTHORIZED", source: "ai" });
    expect(actor.getSnapshot().value).toBe("retrying");
    actor.send({ type: "RETRY_AUTHORIZED", source: "tool" });
    expect(actor.getSnapshot().value).toBe("retrying");
    actor.send({ type: "RETRY_AUTHORIZED", source: "human" });
    expect(actor.getSnapshot().value).toBe("sampling");
  });

  it("requires human authority for cancellation", () => {
    const actor = reachGrounding();
    actor.send({ type: "CANCEL", source: "ai", reason: "ai-wants-out" });
    expect(actor.getSnapshot().value).toBe("grounding");
    actor.send({ type: "CANCEL", source: "human", reason: "operator-halt" });
    expect(actor.getSnapshot().value).toBe("cancelled");
  });

  it("routes a tool permission denial to blocked", () => {
    const actor = reachGrounding();
    actor.send({ type: "PERMISSION_DENIED", source: "tool", reason: "anchor tool unauthorized" });
    expect(actor.getSnapshot().value).toBe("blocked");
  });
});

describe("improvement-loop machine — terminal states", () => {
  it("declares the expected terminal states", () => {
    expect([...IMPROVEMENT_TERMINAL_STATES]).toEqual(["succeeded", "failed", "blocked", "cancelled"]);
  });

  it("reference-change rejection from adjusting lands in failed", () => {
    const actor = startActor();
    samplePair(actor);
    seal(actor);
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "detached" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    passRemainingAnchors(actor);
    actor.send({ type: "EVALUATE", source: "system" });
    actor.send({ type: "REFERENCE_CHANGE_REJECTED", source: "human", reason: "no new reference" });
    expect(actor.getSnapshot().value).toBe("failed");
  });
});
