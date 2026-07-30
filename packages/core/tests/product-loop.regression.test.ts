import { describe, expect, it } from "bun:test";
import {
  type BudgetEnvelope,
  type ControlResult,
  canAutoShip,
  createProductActor,
  evaluateObservation,
  type ObservationMetric,
  type ObservationSample,
  PRODUCT_ALLOWED_CATEGORIES,
  PRODUCT_AUTO_SEALED_ANCHORS,
  PRODUCT_EXTERNAL_ANCHORS,
  PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS,
  PRODUCT_SHIP_GATE_ANCHORS,
  PRODUCT_TERMINAL_STATES,
  PRODUCT_VOTE_EXPIRY_HOURS,
  type ProposalDraft,
  REQUIRED_PRODUCT_ANCHORS,
} from "../src/models/product-loop.machine.js";

type AnyActor = ReturnType<typeof createProductActor>;

const draft = (overrides: Partial<ProposalDraft> = {}): ProposalDraft => ({
  scope: "s",
  category: "performance",
  touchesSensitive: false,
  dependencies: [],
  budgetAllocation: 100,
  rollbackArtifact: "r.md",
  evidence: "e.md",
  ...overrides,
});

const startActor = (runId = "regression"): AnyActor => {
  const actor = createProductActor({ runId });
  actor.start();
  return actor;
};

const sample = (metric: ObservationMetric, exceeded: boolean): ObservationSample => ({
  metric,
  value: exceeded ? 100 : 0,
  threshold: 10,
  exceeded,
  evidence: exceeded ? "bad" : "ok",
});

const budget = (remaining: number): BudgetEnvelope => ({
  initial: 100,
  consumed: 100 - remaining,
  history: [],
});

const passedControl = (): ControlResult => ({ name: "unit", status: "passed", evidence: "e" });

describe("product-loop — architectural regression invariants", () => {
  it("lists exactly the nine required ground-contact anchors", () => {
    expect([...REQUIRED_PRODUCT_ANCHORS]).toHaveLength(9);
    expect(new Set(REQUIRED_PRODUCT_ANCHORS)).toEqual(
      new Set([
        "qualification-passed",
        "vote-quorum",
        "budget-envelope",
        "frozen-set-intact",
        "controls-passed",
        "regression",
        "auto-ship-policy",
        "rollback-path-exists",
        "observation-window",
      ]),
    );
  });

  it("splits anchors into auto-sealed vs tool-recorded", () => {
    expect([...PRODUCT_AUTO_SEALED_ANCHORS]).toEqual([
      "qualification-passed",
      "vote-quorum",
      "budget-envelope",
      "controls-passed",
      "auto-ship-policy",
      "observation-window",
      "rollback-path-exists",
    ]);
    expect([...PRODUCT_EXTERNAL_ANCHORS]).toEqual(["frozen-set-intact", "regression"]);
  });

  it("the only declared terminal states are explicit honest outcomes", () => {
    expect([...PRODUCT_TERMINAL_STATES]).toEqual(["validated", "rejected"]);
  });

  it("exposes the ship-gate anchor subset (must hold before VERIFY_EVALUATE can ship)", () => {
    expect([...PRODUCT_SHIP_GATE_ANCHORS]).toEqual([
      "qualification-passed",
      "vote-quorum",
      "budget-envelope",
      "frozen-set-intact",
      "regression",
    ]);
    // Anchors sealed AFTER the gate passes are excluded to avoid chicken-and-egg.
    expect(PRODUCT_SHIP_GATE_ANCHORS).not.toContain("controls-passed");
    expect(PRODUCT_SHIP_GATE_ANCHORS).not.toContain("auto-ship-policy");
    expect(PRODUCT_SHIP_GATE_ANCHORS).not.toContain("rollback-path-exists");
    expect(PRODUCT_SHIP_GATE_ANCHORS).not.toContain("observation-window");
  });

  it("encodes the deterministic timing constants from the spec", () => {
    expect(PRODUCT_VOTE_EXPIRY_HOURS).toEqual({ standard: 72, criticalSecurity: 12 });
    expect(PRODUCT_OBSERVATION_CONSECUTIVE_MEASUREMENTS).toBe(3);
  });

  it("AI can never open a proposition, qualify, evaluate, or ship", () => {
    const actor = startActor("ai-only");
    actor.send({ type: "PROPOSAL_DRAFTED", source: "ai", draft: draft() });
    // The four control events are tool/system-only; AI-sourced copies are ignored.
    actor.send({ type: "OPEN_PROPOSITION", source: "ai" });
    actor.send({ type: "QUALIFICATION_RUN", source: "ai" });
    actor.send({ type: "VOTE_EVALUATE", source: "ai" });
    actor.send({ type: "VERIFY_EVALUATE", source: "ai" });
    expect(actor.getSnapshot().value).toBe("exploration");
    actor.stop();
  });

  it("AI cannot forge a passed anchor", () => {
    const actor = startActor("forge-anchor");
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "ai",
      anchor: "frozen-set-intact",
      status: "passed",
      evidence: "lie",
    });
    expect(actor.getSnapshot().context.anchors["frozen-set-intact"]).toBeUndefined();
    actor.stop();
  });

  it("AI cannot cancel, resolve a review, or authorize a contact relay", () => {
    const actor = startActor("ai-authority");
    actor.send({ type: "CANCEL", source: "ai", reason: "x" });
    actor.send({ type: "REVIEW_RESOLVED", source: "ai", resolution: "abandoned" });
    actor.send({ type: "CONTACT_RELAY_AUTHORIZED", source: "ai" });
    // Still in an active (non-terminal) state — the AI events were rejected.
    expect(actor.getSnapshot().status).not.toBe("done");
    expect(actor.getSnapshot().value).toBe("exploration");
    actor.stop();
  });

  it("terminal states reject every later event", () => {
    const actor = startActor("terminal-lock");
    actor.send({ type: "PROPOSAL_DRAFTED", source: "ai", draft: draft() });
    actor.send({ type: "OPEN_PROPOSITION", source: "tool" });
    actor.send({ type: "QUALIFICATION_RUN", source: "tool" });
    actor.send({ type: "VOTE_OPENED", source: "tool", config: { quorum: 1, kind: "standard", expiryHours: 72 } });
    actor.send({ type: "VOTE_EXPIRED", source: "tool" });
    expect(actor.getSnapshot().value).toBe("rejected");
    actor.send({ type: "VOTE_CAST", source: "tool", favorable: 999 });
    expect(actor.getSnapshot().value).toBe("rejected");
    actor.stop();
  });
});

describe("product-loop — pure policy edge cases", () => {
  const okCtx = () => ({ draft: draft(), controls: { unit: passedControl() }, budget: budget(90) });

  it("evaluateObservation never rolls back below the consecutive threshold", () => {
    const degraded = sample("errors", true);
    expect(evaluateObservation([degraded, degraded], true).confirmed).toBe(false);
    expect(evaluateObservation([degraded, degraded, degraded], true).confirmed).toBe(true);
    // A single measurement cannot confirm even at window end.
    expect(evaluateObservation([degraded], true).confirmed).toBe(false);
  });

  it("evaluateObservation prioritizes errors over aiCost over latency", () => {
    const errors = sample("errors", true);
    const aiCost = sample("aiCost", true);
    // 3 consecutive errors beats 3 consecutive aiCost.
    const out = evaluateObservation([errors, errors, errors, aiCost, aiCost, aiCost], true);
    expect(out.confirmed).toBe(true);
    expect(out.metric).toBe("errors");
  });

  it("evaluateObservation detection is fail-fast (windowElapsed is enforced by the validated guard, not here)", () => {
    // The pure detector confirms the instant 3 consecutive breaches occur, even
    // mid-window. The `observationClean` GUARD additionally requires
    // windowElapsed=true for the validated transition (verified by machine tests).
    const degraded = sample("errors", true);
    expect(evaluateObservation([degraded, degraded, degraded], false).confirmed).toBe(true);
  });

  it("canAutoShip requires every gate", () => {
    expect(canAutoShip(okCtx()).allowed).toBe(true);
    // category 'security' is auto-votable but never auto-shippable
    expect(canAutoShip({ ...okCtx(), draft: draft({ category: "security" }) }).allowed).toBe(false);
    // a sensitive change requires human review before deploy
    expect(canAutoShip({ ...okCtx(), draft: draft({ touchesSensitive: true }) }).allowed).toBe(false);
    // rollback path must exist (non-empty artifact)
    expect(canAutoShip({ ...okCtx(), draft: draft({ rollbackArtifact: "" }) }).allowed).toBe(false);
    // budget must remain
    expect(canAutoShip({ ...okCtx(), budget: budget(0) }).allowed).toBe(false);
    // a failing control blocks ship
    expect(canAutoShip({ ...okCtx(), controls: { unit: { ...passedControl(), status: "failed" } } }).allowed).toBe(
      false,
    );
    // no controls recorded blocks ship
    expect(canAutoShip({ ...okCtx(), controls: {} }).allowed).toBe(false);
  });

  it("declares the allowed auto-ship categories including security (auto-votable, not auto-shippable)", () => {
    expect([...PRODUCT_ALLOWED_CATEGORIES]).toContain("performance");
    expect([...PRODUCT_ALLOWED_CATEGORIES]).toContain("security");
  });
});
