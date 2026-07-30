import { describe, expect, it } from "bun:test";
import {
  budgetRemaining,
  type ControlResult,
  createProductActor,
  type ObservationMetric,
  type ObservationSample,
  PRODUCT_EXTERNAL_ANCHORS,
  PRODUCT_TERMINAL_STATES,
  type ProductAnchorName,
  type ProposalDraft,
  REQUIRED_PRODUCT_ANCHORS,
  type VoteConfig,
} from "../src/models/product-loop.machine.js";

type AnyActor = ReturnType<typeof createProductActor>;

const baseDraft: ProposalDraft = {
  scope: "optimize-query-cache",
  category: "performance",
  touchesSensitive: false,
  dependencies: ["cache-layer"],
  budgetAllocation: 100,
  rollbackArtifact: "evidence/rollback/revert.md",
  evidence: "evidence/perf/baseline.md",
};

const standardVote: VoteConfig = { quorum: 1, kind: "standard", expiryHours: 72 };

const reachVote = (runId = "machine-nominal", draft: ProposalDraft = baseDraft): AnyActor => {
  const actor = createProductActor({ runId });
  actor.start();
  actor.send({ type: "PROPOSAL_DRAFTED", source: "ai", draft });
  actor.send({ type: "OPEN_PROPOSITION", source: "tool" });
  actor.send({ type: "QUALIFICATION_RUN", source: "tool" });
  actor.send({ type: "VOTE_OPENED", source: "tool", config: standardVote });
  return actor;
};

/** Record the two external (tool-only) anchors the machine never auto-seals. */
const passExternalAnchors = (actor: AnyActor) => {
  for (const anchor of PRODUCT_EXTERNAL_ANCHORS) {
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: anchor as ProductAnchorName,
      status: "passed",
      evidence: `${anchor}-ok`,
    });
  }
};

const passedControl = (): ControlResult => ({ name: "unit", status: "passed", evidence: "evidence/tests/unit.md" });

const sample = (metric: ObservationMetric, exceeded: boolean): ObservationSample => ({
  metric,
  value: exceeded ? 100 : 0,
  threshold: 10,
  exceeded,
  evidence: exceeded ? "evidence/obs/breach.md" : "evidence/obs/clean.md",
});

const driveToObservation = (actor: AnyActor) => {
  actor.send({ type: "VOTE_CAST", source: "tool", favorable: 1 });
  actor.send({ type: "VOTE_EVALUATE", source: "system" });
  actor.send({
    type: "BUDGET_CHARGE",
    source: "tool",
    action: { amount: 10, description: "impl", evidence: "evidence/diff/change.md" },
  });
  actor.send({ type: "EXECUTION_DONE", source: "tool" });
  actor.send({ type: "VERIFY_RUN", source: "tool", control: passedControl() });
  passExternalAnchors(actor);
  actor.send({ type: "VERIFY_EVALUATE", source: "system" });
};

describe("product-loop machine — nominal transitions", () => {
  it("reaches validated only through the full nominal path with all 9 anchors passed", () => {
    const actor = reachVote();
    driveToObservation(actor);
    expect(actor.getSnapshot().value).toBe("observation");
    actor.send({ type: "OBSERVATION_SAMPLE", source: "tool", sample: sample("errors", false) });
    actor.send({ type: "OBSERVATION_SAMPLE", source: "tool", sample: sample("aiCost", false) });
    actor.send({ type: "OBSERVATION_SAMPLE", source: "tool", sample: sample("latency", false) });
    actor.send({ type: "OBSERVATION_EVALUATE", source: "system", windowElapsed: true });

    const snap = actor.getSnapshot();
    expect(snap.value).toBe("validated");
    expect(snap.status).toBe("done");
    expect(Object.keys(snap.context.anchors)).toHaveLength(REQUIRED_PRODUCT_ANCHORS.length);
    actor.stop();
  });

  it("stays in vote after VOTE_CAST below quorum until VOTE_EVALUATE", () => {
    const actor = reachVote("quorum-pending");
    actor.send({ type: "VOTE_CAST", source: "tool", favorable: 0 });
    actor.send({ type: "VOTE_EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("vote");
    actor.stop();
  });

  it("reaches rejected (terminal) on expiry without quorum", () => {
    const actor = reachVote("expiry");
    actor.send({ type: "VOTE_EXPIRED", source: "tool" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("rejected");
    expect(PRODUCT_TERMINAL_STATES).toContain(snap.value);
    expect(snap.status).toBe("done");
    actor.stop();
  });

  it("auto-escalates budgetBlocked -> review and lets a human expand the budget", () => {
    const actor = reachVote("budget-escape", { ...baseDraft, budgetAllocation: 5 });
    actor.send({ type: "VOTE_CAST", source: "tool", favorable: 1 });
    actor.send({ type: "VOTE_EVALUATE", source: "system" });
    actor.send({
      type: "BUDGET_CHARGE",
      source: "tool",
      action: { amount: 5, description: "drain", evidence: "evidence/budget/burn.md" },
    });
    const blocked = actor.getSnapshot();
    expect(blocked.value).toBe("review");
    expect(blocked.context.reviewReason).toBe("budget-exhausted");
    // AI cannot self-expand.
    actor.send({ type: "REVIEW_RESOLVED", source: "ai", resolution: "budget-expanded", expandedBudget: 50 });
    expect(actor.getSnapshot().value).toBe("review");
    // Human expands (must exceed consumed = 5).
    actor.send({ type: "REVIEW_RESOLVED", source: "human", resolution: "budget-expanded", expandedBudget: 50 });
    const resumed = actor.getSnapshot();
    expect(resumed.value).toBe("execution");
    expect(budgetRemaining(resumed.context.budget)).toBe(45);
    actor.stop();
  });

  it("opens a corrective proposition after confirmed rollback (3 consecutive breaches)", () => {
    const actor = reachVote("rollback-path");
    driveToObservation(actor);
    for (let i = 0; i < 3; i++) {
      actor.send({ type: "OBSERVATION_SAMPLE", source: "tool", sample: sample("errors", true) });
    }
    actor.send({ type: "OBSERVATION_EVALUATE", source: "system", windowElapsed: true });
    expect(actor.getSnapshot().value).toBe("rollback");
    actor.send({ type: "CORRECTIVE_PROPOSITION_OPENED", source: "tool" });
    expect(actor.getSnapshot().value).toBe("proposition");
    actor.stop();
  });

  it("does not roll back on a single degraded measurement", () => {
    const actor = reachVote("single-sample");
    driveToObservation(actor);
    actor.send({ type: "OBSERVATION_SAMPLE", source: "tool", sample: sample("errors", true) });
    actor.send({ type: "OBSERVATION_EVALUATE", source: "system", windowElapsed: true });
    expect(actor.getSnapshot().value).toBe("validated");
    actor.stop();
  });

  it("routes a sensitive security proposal to review instead of ship", () => {
    const actor = reachVote("sensitive-review", {
      ...baseDraft,
      category: "security",
      touchesSensitive: true,
    });
    actor.send({ type: "VOTE_CAST", source: "tool", favorable: 1 });
    actor.send({ type: "VOTE_EVALUATE", source: "system" });
    actor.send({
      type: "BUDGET_CHARGE",
      source: "tool",
      action: { amount: 1, description: "impl", evidence: "evidence/diff/sec.md" },
    });
    actor.send({ type: "EXECUTION_DONE", source: "tool" });
    actor.send({ type: "VERIFY_RUN", source: "tool", control: passedControl() });
    passExternalAnchors(actor);
    actor.send({ type: "VERIFY_EVALUATE", source: "system" });
    expect(actor.getSnapshot().value).toBe("review");
    actor.stop();
  });

  it("human CANCEL from an active state reaches the rejected terminal", () => {
    const actor = reachVote("cancel");
    actor.send({ type: "CANCEL", source: "human", reason: "duplicate" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("rejected");
    expect(snap.status).toBe("done");
    actor.stop();
  });
});
