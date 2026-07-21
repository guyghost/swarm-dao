import { describe, expect, it } from "bun:test";
import { createActor } from "xstate";
import { improvementMachine, REQUIRED_IMPROVEMENT_ANCHORS } from "../src/models/improvement-loop.machine.js";

type AnyActor = ReturnType<typeof createActor<typeof improvementMachine>>;

const startActor = (referenceHash = "ref-a") => {
  const actor = createActor(improvementMachine, { input: { cycleId: "frozen-test", scope: "s", referenceHash } });
  actor.start();
  return actor;
};

const samplePair = (actor: AnyActor) => {
  actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
  actor.send({ type: "COUNTER_SAMPLED", source: "ai", sample: { value: "rose", evidence: "c" } });
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

const remainingAnchors = REQUIRED_IMPROVEMENT_ANCHORS.filter(
  (a) => a !== "counter-metric-paired" && a !== "arbitration-policy",
);

describe("improvement-loop — frozen set & retry survival", () => {
  it("retains surviving anchors across retry and accepts a survived frozen-set-intact on the new attempt", () => {
    const actor = reachGrounding();
    // record frozen-set-intact + drift-audit this attempt
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "frozen-set-intact",
      status: "passed",
      evidence: "hash-match",
    });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "drift-audit",
      status: "passed",
      evidence: "drift-ok",
    });
    // skip anchor-reality + regression -> evaluate fails closed into retrying
    actor.send({ type: "EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("retrying");

    actor.send({ type: "RETRY_AUTHORIZED", source: "human" });
    const afterRetry = actor.getSnapshot();
    expect(afterRetry.value).toBe("sampling");
    expect(afterRetry.context.attempt).toBe(1);
    // survivors retained
    expect(afterRetry.context.anchors["frozen-set-intact"]?.status).toBe("passed");
    expect(afterRetry.context.anchors["counter-metric-paired"]?.status).toBe("passed");
    // non-survivors cleared
    expect(afterRetry.context.anchors["drift-audit"]).toBeUndefined();
    expect(afterRetry.context.anchors["arbitration-policy"]).toBeUndefined();

    // complete the new attempt; frozen-set-intact from attempt 0 must still count
    samplePair(actor);
    seal(actor);
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "drift-audit",
      status: "passed",
      evidence: "drift-ok-2",
    });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "anchor-reality",
      status: "passed",
      evidence: "real-2",
    });
    actor.send({ type: "ANCHOR_RECORDED", source: "tool", anchor: "regression", status: "passed", evidence: "reg-2" });
    actor.send({ type: "EVALUATE", source: "system" });

    const succeeded = actor.getSnapshot();
    expect(succeeded.value).toBe("succeeded");
    // frozen-set-intact was NOT re-recorded on attempt 1 but still satisfies the invariant
    expect(succeeded.context.anchors["frozen-set-intact"]?.attempt).toBe(0);
  });

  it("a failed frozen-set-intact survives retry as failed and can never be unfrozen into success", () => {
    const actor = reachGrounding();
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "frozen-set-intact",
      status: "failed",
      evidence: "hash-drift",
    });
    for (const a of remainingAnchors.filter((x) => x !== "frozen-set-intact")) {
      actor.send({ type: "ANCHOR_RECORDED", source: "tool", anchor: a, status: "passed", evidence: `${a}-ok` });
    }
    actor.send({ type: "EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("retrying");

    actor.send({ type: "RETRY_AUTHORIZED", source: "human" });
    samplePair(actor);
    seal(actor);
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
    actor.send({ type: "ARBITRATION", source: "tool", outcome: "balanced" });
    for (const a of remainingAnchors.filter((x) => x !== "frozen-set-intact")) {
      actor.send({ type: "ANCHOR_RECORDED", source: "tool", anchor: a, status: "passed", evidence: `${a}-ok-2` });
    }
    // frozen-set-intact still failed from attempt 0 and was NOT re-recorded
    actor.send({ type: "EVALUATE", source: "system" });
    // attempt 1, still retries available -> retrying, never succeeded
    expect(actor.getSnapshot().value).toBe("retrying");
  });

  it("counter-metric is mandatory: no seal, no grounding", () => {
    const actor = startActor();
    actor.send({ type: "METRIC_SAMPLED", source: "ai", sample: { value: "rose", evidence: "m" } });
    // counter never sampled
    actor.send({ type: "SAMPLES_SEALED", source: "tool" });
    expect(actor.getSnapshot().value).toBe("sampling");
    actor.send({ type: "DRIFT_ESTIMATE", source: "ai", driftClass: "none" });
    expect(actor.getSnapshot().value).toBe("sampling");
  });
});
