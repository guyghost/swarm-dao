import { describe, expect, it, spyOn } from "bun:test";
import { SUITES } from "../benchmarks/index.js";
import {
  adjudicateRegressions,
  calibrationSlowdown,
  compareReports,
  ioCalibrationSlowdown,
  reMeasureCase,
} from "../scripts/compare-benchmarks.js";
import { type BenchmarkMeasurement, type BenchmarkReport, formatReport, summarize } from "../src/harness.js";

const CASE = "file persist (1 proposal)";
const gates = { threshold: 0.25, floorMs: 0.05, slowdown: 1, ioSlowdown: 1 };

function report(...measurements: BenchmarkMeasurement[]): BenchmarkReport {
  return { generatedAt: "2031-01-01T00:00:00.000Z", runtime: "test", measurements };
}

describe("bench:compare — per-iteration estimator (issue #218)", () => {
  it("ignores one filesystem stall in an otherwise unchanged small I/O case", () => {
    const baseline = report(summarize("persistence", CASE, Array(25).fill(1.735)));
    const current = report(summarize("persistence", CASE, [...Array(24).fill(1.735), 481.535]));
    // Reproduce the reported 20.927ms run mean without a wall-clock race.
    expect(current.measurements[0]?.meanMs).toBe(20.927);
    expect(compareReports(current, baseline, gates.threshold)[0]).toMatchObject({
      status: "ok",
      currentMs: 1.735,
      baselineMs: 1.735,
      changeRatio: 0,
    });
  });

  it("does not let an inflated baseline mean hide a sustained regression", async () => {
    const baseline = report(summarize("persistence", CASE, [...Array(24).fill(1.735), 481.535]));
    const current = report(summarize("persistence", CASE, Array(25).fill(3)));
    const comparisons = compareReports(current, baseline, gates.threshold);
    expect(comparisons[0]).toMatchObject({ status: "regression", currentMs: 3, baselineMs: 1.735 });
    const result = await adjudicateRegressions(comparisons, baseline, gates, async () => [3, 3.1, 3.2]);
    expect(result.confirmed).toHaveLength(1);
    expect(result.dismissed).toHaveLength(0);
  });

  it("adjudicates against the baseline minimum even when its mean is inflated", async () => {
    const baseline = report(summarize("persistence", CASE, [...Array(24).fill(1.735), 481.535]));
    const flagged = [
      {
        suite: "persistence",
        name: CASE,
        currentMs: 3,
        baselineMs: 1.735,
        changeRatio: (3 - 1.735) / 1.735,
        status: "regression" as const,
      },
    ];
    const result = await adjudicateRegressions(flagged, baseline, gates, async () => [3, 3.1, 3.2]);
    expect(result.confirmed).toHaveLength(1);
    expect(result.dismissed).toHaveLength(0);
  });

  it("calibrates from iteration minima so kernel stalls cannot relax the gate", () => {
    const baseline = report(
      summarize("calibration", "reference kernel", [0.5, 0.5, 0.5]),
      summarize("calibration-io", "io kernel", [0.2, 0.2, 0.2]),
      summarize("persistence", CASE, [1.735, 1.735, 1.735]),
    );
    const current = report(
      summarize("calibration", "reference kernel", [0.5, 0.5, 20]),
      summarize("calibration-io", "io kernel", [0.2, 0.2, 20]),
      summarize("persistence", CASE, [3, 3, 3]),
    );
    const slowdown = calibrationSlowdown(current, baseline);
    const ioSlowdown = ioCalibrationSlowdown(current, baseline);
    expect(slowdown).toBe(1);
    expect(ioSlowdown).toBe(1);
    expect(compareReports(current, baseline, 0.25, 0.05, slowdown ?? 1, ioSlowdown ?? 1).at(-1)?.status).toBe(
      "regression",
    );
  });

  it("uses the baseline kernel minimum when its mean contains a stall", () => {
    const baseline = report(summarize("calibration-io", "io kernel", [0.2, 0.2, 20]));
    const current = report(summarize("calibration-io", "io kernel", [0.4, 0.4, 0.4]));
    expect(ioCalibrationSlowdown(current, baseline)).toBe(2);
  });

  it("still flags a sustained regression from a rounded-zero baseline minimum", async () => {
    const baseline = report(summarize("artefacts", "tiny case", [0.0001, 0.01]));
    const current = report(summarize("artefacts", "tiny case", [0.1, 0.1]));
    const comparisons = compareReports(current, baseline, gates.threshold);
    expect(comparisons[0]).toMatchObject({
      status: "regression",
      baselineMs: 0,
      changeRatio: Number.POSITIVE_INFINITY,
    });
    const result = await adjudicateRegressions(comparisons, baseline, gates, async () => [0.1, 0.1, 0.1]);
    expect(result.confirmed).toHaveLength(1);
    expect(result.dismissed).toHaveLength(0);
  });

  it("tolerates rounded-zero baseline changes inside the absolute floor", async () => {
    const baseline = report(summarize("artefacts", "tiny case", [0.0001, 0.01]));
    for (const currentMs of [0, 0.01, 0.05]) {
      const current = report(summarize("artefacts", "tiny case", [currentMs]));
      expect(compareReports(current, baseline, gates.threshold)[0]?.status).toBe("ok");
    }
    const flagged = compareReports(report(summarize("artefacts", "tiny case", [0.1])), baseline, gates.threshold);
    const result = await adjudicateRegressions(flagged, baseline, gates, async () => [0.01, 0.02, 0]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.dismissed[0]?.reMeasuredMs).toBe(0);
  });

  it("shows the gated minimum alongside mean and p95 diagnostics", () => {
    const output = formatReport(report(summarize("persistence", CASE, [1.2, 1.2, 200])));
    expect(output).toContain("min (ms)");
    expect(output).toContain("mean (ms)");
    expect(output).toContain("p95 (ms)");
  });

  for (const steadyMs of [1.2, 3]) {
    it(`${steadyMs === 1.2 ? "dismisses noise" : "confirms a sustained regression"} with a stall in every remeasurement attempt`, async () => {
      // Only the clock is controlled: the real runCase/summarize/reMeasureCase
      // path executes five 100-iteration attempts, each with one 200ms stall.
      // Every old run mean exceeds the 2.16875ms gate, even at a 1.2ms true cost.
      let now = 0;
      let iteration = 0;
      let setups = 0;
      let teardowns = 0;
      const suite = {
        name: "issue-218-fixture",
        warmupIterations: 0,
        setup: () => {
          iteration = 0;
          setups++;
        },
        teardown: () => {
          teardowns++;
        },
        cases: [
          {
            name: CASE,
            run: () => {
              now += ++iteration === 100 ? 200 : steadyMs;
            },
          },
        ],
      };
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      SUITES.push(suite);
      try {
        const baseline = report(summarize(suite.name, CASE, [1.735, 1.735]));
        const flagged = compareReports(report(summarize(suite.name, CASE, [20, 20])), baseline, gates.threshold);
        const minima = await reMeasureCase(suite.name, CASE);
        expect(minima).toEqual(Array(5).fill(steadyMs));
        expect(setups).toBe(5);
        expect(teardowns).toBe(5);
        const result = await adjudicateRegressions(flagged, baseline, gates, async () => minima);
        expect(result.confirmed).toHaveLength(steadyMs === 3 ? 1 : 0);
        expect(result.dismissed).toHaveLength(steadyMs === 1.2 ? 1 : 0);
        if (steadyMs === 1.2) expect(result.dismissed[0]?.reMeasuredMs).toBe(steadyMs);
      } finally {
        SUITES.splice(SUITES.indexOf(suite), 1);
        clock.mockRestore();
      }
    });
  }
});
