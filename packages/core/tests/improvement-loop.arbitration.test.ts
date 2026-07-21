import { describe, expect, it } from "bun:test";
import { arbitratePairedSignals, assertFrozenSetIntact } from "../src/models/improvement-loop.machine.js";

describe("improvement-loop — deterministic paired-signal arbitration", () => {
  it("returns missing-pair when either signal is absent", () => {
    expect(arbitratePairedSignals(null, null)).toEqual({ outcome: "missing-pair", arbitrationPolicyPassed: false });
    expect(arbitratePairedSignals({ value: "rose", evidence: "m" }, null).arbitrationPolicyPassed).toBe(false);
    expect(arbitratePairedSignals(null, { value: "rose", evidence: "c" }).arbitrationPolicyPassed).toBe(false);
  });

  it("vetoes when the optimizing metric rises but the counter-metric declines", () => {
    const result = arbitratePairedSignals(
      { value: "rose", evidence: "metric-rose" },
      { value: "declined", evidence: "counter-fell" },
    );
    expect(result.arbitrationPolicyPassed).toBe(false);
    expect(result.outcome).toBe("counter-veto:metric-rose-counter-fell");
  });

  it("passes when both move together (balanced)", () => {
    const result = arbitratePairedSignals(
      { value: "rose", evidence: "metric-rose" },
      { value: "rose", evidence: "counter-rose" },
    );
    expect(result.arbitrationPolicyPassed).toBe(true);
    expect(result.outcome).toBe("balanced");
  });

  it("passes when the optimizing metric declines regardless of counter (no false optimization)", () => {
    const result = arbitratePairedSignals(
      { value: "declined", evidence: "metric-fell" },
      { value: "rose", evidence: "counter-rose" },
    );
    expect(result.arbitrationPolicyPassed).toBe(true);
  });

  it("is pure: identical inputs always yield identical outputs", () => {
    const a = arbitratePairedSignals({ value: "rose", evidence: "x" }, { value: "declined", evidence: "y" });
    const b = arbitratePairedSignals({ value: "rose", evidence: "x" }, { value: "declined", evidence: "y" });
    expect(a).toEqual(b);
  });
});

describe("improvement-loop — frozen-set integrity", () => {
  it("passes only when hashes are non-empty and identical", () => {
    expect(assertFrozenSetIntact("abc", "abc")).toBe(true);
    expect(assertFrozenSetIntact("abc", "abd")).toBe(false);
    expect(assertFrozenSetIntact("", "abc")).toBe(false);
    expect(assertFrozenSetIntact("abc", "")).toBe(false);
    expect(assertFrozenSetIntact("abc", "  ")).toBe(false);
  });

  it("rejects whitespace-only hashes", () => {
    expect(assertFrozenSetIntact("   ", "   ")).toBe(false);
  });
});
