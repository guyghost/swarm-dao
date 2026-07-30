import { describe, expect, it } from "bun:test";
import { validateProductSignal } from "../signal.js";

const baseToolSignal = {
  runId: "product-signal-test",
  type: "QUALIFICATION_RUN",
  source: "tool",
  producer: "qualifier",
  occurredAt: "2026-07-30T10:00:00.000Z",
  payload: {
    permissionCleared: true,
    permissionEvidence: "permissions: none required (performance category)",
  },
  evidence: ["permissions: none required (performance category)"],
};

describe("product signal validation", () => {
  it("accepts a valid QUALIFICATION_RUN signal with explicit permission clearance", () => {
    const result = validateProductSignal(baseToolSignal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.type).toBe("QUALIFICATION_RUN");
    if (result.event.type !== "QUALIFICATION_RUN") return;
    expect(result.event.permissionCleared).toBe(true);
    expect(result.event.permissionEvidence).toBe("permissions: none required (performance category)");
  });

  it("rejects QUALIFICATION_RUN without permissionCleared", () => {
    const result = validateProductSignal({
      ...baseToolSignal,
      payload: { permissionEvidence: "permissions: none required" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toMatch(/permissionCleared/);
  });

  it("rejects QUALIFICATION_RUN without permissionEvidence", () => {
    const result = validateProductSignal({
      ...baseToolSignal,
      payload: { permissionCleared: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join("\n")).toMatch(/permissionEvidence/);
  });

  it("rejects AI attempts to carry owner-authority keys", () => {
    const aiBase = {
      runId: "product-signal-test",
      type: "PROPOSAL_DRAFTED",
      source: "ai",
      producer: "proposer",
      occurredAt: "2026-07-30T10:00:00.000Z",
      payload: {
        draft: {
          scope: "optimize cache",
          category: "performance",
          touchesSensitive: false,
          dependencies: [],
          budgetAllocation: 50,
          rollbackArtifact: "revert.patch",
          evidence: "baseline.md",
        },
      },
      evidence: ["baseline.md"],
    };

    for (const key of ["approval", "expandedBudget", "resolution", "cancel", "favorable", "quorum"]) {
      const result = validateProductSignal({
        ...aiBase,
        payload: { ...aiBase.payload, [key]: "forged" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.join("\n")).toMatch(new RegExp(key));
    }
  });

  it("rejects any signal carrying a state-transition target", () => {
    for (const key of ["nextState", "targetState", "transition", "target"]) {
      const result = validateProductSignal({
        ...baseToolSignal,
        payload: { ...baseToolSignal.payload, [key]: "vote" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.join("\n")).toMatch(new RegExp(key));
    }
  });

  it("rejects a wrong source for a given event type", () => {
    // QUALIFICATION_RUN is tool-only.
    expect(validateProductSignal({ ...baseToolSignal, source: "ai" }).ok).toBe(false);
    expect(validateProductSignal({ ...baseToolSignal, source: "human" }).ok).toBe(false);
    expect(validateProductSignal({ ...baseToolSignal, source: "system" }).ok).toBe(false);
  });

  it("binds event authority to the producer's declared graph node", () => {
    // An AI producer (proposer) cannot emit a human-authority event (CANCEL).
    const forged = validateProductSignal({
      runId: "product-signal-test",
      type: "CANCEL",
      source: "human",
      producer: "proposer",
      occurredAt: "2026-07-30T10:00:00.000Z",
      payload: { reason: "forged by an AI producer" },
      evidence: ["forged"],
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.issues.join("\n")).toMatch(/proposer.*CANCEL|not declared/);
  });

  it("accepts a valid ANCHOR_RECORDED for all three external anchors", () => {
    for (const anchor of ["frozen-set-intact", "regression", "rollback-path-exists"]) {
      const result = validateProductSignal({
        runId: "product-signal-test",
        type: "ANCHOR_RECORDED",
        source: "tool",
        producer: "verifier",
        occurredAt: "2026-07-30T10:00:00.000Z",
        payload: { anchor, status: "passed" },
        evidence: [`${anchor} confirmed`],
      });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects ANCHOR_RECORDED for an unknown anchor name", () => {
    const result = validateProductSignal({
      runId: "product-signal-test",
      type: "ANCHOR_RECORDED",
      source: "tool",
      producer: "verifier",
      occurredAt: "2026-07-30T10:00:00.000Z",
      payload: { anchor: "not-a-real-anchor", status: "passed" },
      evidence: ["evidence"],
    });
    expect(result.ok).toBe(false);
  });
});
