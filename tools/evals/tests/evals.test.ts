import { describe, expect, it } from "bun:test";
import { compareScorecards, hasRegressions } from "../compare.js";
import { EVAL_SUITE, type EvalResult, type Scorecard } from "../suite.js";

function result(id: string, status: EvalResult["status"], durationMs = 10): EvalResult {
  return { id, command: `bun test ${id}`, status, exitCode: status === "passed" ? 0 : 1, durationMs };
}

function scorecard(results: EvalResult[], totalMs = results.reduce((sum, r) => sum + r.durationMs, 0)): Scorecard {
  return {
    label: "test",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    results,
    summary: { total: results.length, passed: results.filter((r) => r.status === "passed").length, failed: 0, totalMs },
  };
}

describe("eval suite integrity", () => {
  it("has unique, well-formed ids and bun commands", () => {
    const ids = EVAL_SUITE.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of EVAL_SUITE) {
      expect(entry.id).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
      expect(entry.command).toMatch(/^bun (run|test) \S/);
    }
  });

  it("covers every machine area plus the cross-cutting gates", () => {
    const areas = new Set(EVAL_SUITE.map((entry) => entry.area));
    for (const area of ["graph-engineering", "improvement-loop", "product-loop", "ship-audit", "core", "docs"]) {
      expect(areas.has(area as never)).toBe(true);
    }
  });
});

describe("compareScorecards", () => {
  it("flags passed→failed as a regression and blocks adoption", () => {
    const base = scorecard([result("a", "passed"), result("b", "passed")]);
    const candidate = scorecard([result("a", "passed"), result("b", "failed", 20)]);
    const diff = compareScorecards(base, candidate);
    expect(diff.regressions.map((r) => r.id)).toEqual(["b"]);
    expect(hasRegressions(diff)).toBe(true);
    expect(diff.durationDeltaMs).toBe(10);
  });

  it("flags failed→passed as an improvement, not a regression", () => {
    const base = scorecard([result("a", "failed"), result("b", "passed")]);
    const candidate = scorecard([result("a", "passed"), result("b", "passed")]);
    const diff = compareScorecards(base, candidate);
    expect(diff.improvements.map((r) => r.id)).toEqual(["a"]);
    expect(hasRegressions(diff)).toBe(false);
  });

  it("reports suite drift in both directions", () => {
    const base = scorecard([result("a", "passed"), result("b", "passed")]);
    const candidate = scorecard([result("a", "passed"), result("c", "passed")]);
    const diff = compareScorecards(base, candidate);
    expect(diff.added).toEqual(["c"]);
    expect(diff.removed).toEqual(["b"]);
    expect(hasRegressions(diff)).toBe(false);
  });
});
