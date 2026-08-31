import { describe, expect, it } from "bun:test";
import { parseArgs, SUITES } from "../benchmarks/index.js";
import { calibrationSlowdown, compareReports, formatComparisons } from "../scripts/compare-benchmarks.js";
import { type BenchmarkReport, formatReport, runSuites, summarize } from "../src/harness.js";

function report(measurements: Array<{ suite: string; name: string; meanMs: number }>): BenchmarkReport {
  return {
    generatedAt: "2031-01-01T00:00:00.000Z",
    runtime: "test",
    measurements: measurements.map((measurement) => ({
      ...measurement,
      iterations: 1,
      minMs: measurement.meanMs,
      maxMs: measurement.meanMs,
      p95Ms: measurement.meanMs,
      opsPerSecond: 1000 / measurement.meanMs,
    })),
  };
}

describe("benchmark harness", () => {
  it("summarizes durations into mean, p95 and throughput", () => {
    const measurement = summarize("suite", "case", [1, 2, 3, 4]);
    expect(measurement.iterations).toBe(4);
    expect(measurement.meanMs).toBe(2.5);
    expect(measurement.minMs).toBe(1);
    expect(measurement.maxMs).toBe(4);
    expect(measurement.p95Ms).toBe(4);
    expect(measurement.opsPerSecond).toBe(400);
  });

  it("runs setup and teardown once around every case", async () => {
    const calls: string[] = [];
    const result = await runSuites(
      [
        {
          name: "demo",
          setup: () => {
            calls.push("setup");
          },
          teardown: () => {
            calls.push("teardown");
          },
          cases: [
            {
              name: "first",
              run: () => {
                calls.push("first");
              },
            },
            {
              name: "second",
              run: () => {
                calls.push("second");
              },
            },
          ],
        },
      ],
      { iterations: 2 },
    );

    expect(calls[0]).toBe("setup");
    expect(calls[calls.length - 1]).toBe("teardown");
    expect(result.measurements.map((measurement) => measurement.name)).toEqual(["first", "second"]);
    expect(result.measurements.every((measurement) => measurement.iterations === 2)).toBe(true);
    expect(formatReport(result)).toContain("demo");
  });

  it("declares every core suite", () => {
    expect(SUITES.map((suite) => suite.name)).toEqual(["calibration", "deliberation", "persistence", "artefacts"]);
    expect(SUITES.every((suite) => suite.cases.length > 0)).toBe(true);
  });

  it("parses CLI flags", () => {
    expect(parseArgs(["--json", "out.json", "--iterations", "5", "--filter", "artefacts"])).toEqual({
      json: "out.json",
      iterations: 5,
      filter: "artefacts",
    });
    expect(parseArgs([])).toEqual({});
  });

  it("flags a slower run as a regression and tolerates noise below the threshold", () => {
    const baseline = report([{ suite: "s", name: "a", meanMs: 10 }]);
    const noisy = compareReports(report([{ suite: "s", name: "a", meanMs: 11 }]), baseline, 0.25);
    const slower = compareReports(report([{ suite: "s", name: "a", meanMs: 20 }]), baseline, 0.25);

    expect(noisy[0]?.status).toBe("ok");
    expect(slower[0]?.status).toBe("regression");
    expect(slower[0]?.changeRatio).toBe(1);
    expect(formatComparisons(slower)).toContain("REGRESSION");
  });

  it("tolerates large relative jitter when the absolute delta is below the noise floor", () => {
    // 0.006ms vs 0.004ms is +50% but only 2µs — timer noise, not a regression.
    const baseline = report([{ suite: "artefacts", name: "decision brief", meanMs: 0.004 }]);
    const jitter = compareReports(
      report([{ suite: "artefacts", name: "decision brief", meanMs: 0.006 }]),
      baseline,
      0.25,
    );
    expect(jitter[0]?.status).toBe("ok");
    expect(jitter[0]?.changeRatio).toBe(0.5);

    // 0.3ms vs 0.1ms is +200% and +0.2ms — above the floor, a real regression.
    const real = compareReports(
      report([{ suite: "s", name: "a", meanMs: 0.3 }]),
      report([{ suite: "s", name: "a", meanMs: 0.1 }]),
      0.25,
    );
    expect(real[0]?.status).toBe("regression");

    // A custom floor of zero restores pure-ratio behavior.
    const strict = compareReports(
      report([{ suite: "artefacts", name: "decision brief", meanMs: 0.006 }]),
      baseline,
      0.25,
      0,
    );
    expect(strict[0]?.status).toBe("regression");
  });

  it("marks measurements missing from the baseline as new", () => {
    const comparisons = compareReports(report([{ suite: "s", name: "b", meanMs: 3 }]), report([]), 0.25);
    expect(comparisons[0]?.status).toBe("new");
    expect(comparisons[0]?.baselineMs).toBeNull();
  });
});

describe("calibrated comparison", () => {
  const cal = (meanMs: number) => report([{ suite: "calibration", name: "reference kernel", meanMs }]);

  it("computes the runner slowdown ratio from the calibration kernel", () => {
    // The PR #76 incident: whole-job runner slowdown of ~1.55x.
    expect(calibrationSlowdown(cal(0.775), cal(0.5))).toBe(1.55);
    // A faster runner never tightens the gate.
    expect(calibrationSlowdown(cal(0.4), cal(0.5))).toBe(1);
    // Absurd ratios are capped so the gate cannot be fully disarmed.
    expect(calibrationSlowdown(cal(5), cal(1))).toBe(3);
    // Missing calibration data on either side is not a slowdown.
    expect(calibrationSlowdown(cal(0.5), report([]))).toBeNull();
    expect(calibrationSlowdown(report([]), cal(0.5))).toBeNull();
  });

  it("does not flag a fleet-wide slow runner as regressions", () => {
    // The exact false positives seen on PR #76: every measurement drifted
    // ~40–55% because the runner itself was slow (calibration x1.55).
    const baseline = report([
      { suite: "calibration", name: "reference kernel", meanMs: 0.5 },
      { suite: "deliberation", name: "deliberate proposal", meanMs: 0.538 },
      { suite: "deliberation", name: "run control gates", meanMs: 0.16 },
      { suite: "persistence", name: "file persist (1 proposal)", meanMs: 0.14 },
    ]);
    const current = report([
      { suite: "calibration", name: "reference kernel", meanMs: 0.775 },
      { suite: "deliberation", name: "deliberate proposal", meanMs: 0.842 }, // was 0.538 (+56.5%)
      { suite: "deliberation", name: "run control gates", meanMs: 0.246 }, // was 0.160 (+53.8%)
      { suite: "persistence", name: "file persist (1 proposal)", meanMs: 0.218 }, // was 0.140 (+55.7%)
    ]);
    const slowdown = calibrationSlowdown(current, baseline);
    expect(slowdown).toBe(1.55);
    const comparisons = compareReports(current, baseline, 0.25, 0.05, slowdown ?? 1);
    expect(comparisons.filter((comparison) => comparison.status === "regression")).toHaveLength(0);
  });

  it("keeps the strict gate when the runner speed is unchanged", () => {
    const baseline = report([
      { suite: "calibration", name: "reference kernel", meanMs: 0.5 },
      { suite: "deliberation", name: "deliberate proposal", meanMs: 0.538 },
    ]);
    const current = report([
      { suite: "calibration", name: "reference kernel", meanMs: 0.5 },
      { suite: "deliberation", name: "deliberate proposal", meanMs: 0.842 }, // was 0.538 (+56.5%)
    ]);
    const comparisons = compareReports(current, baseline, 0.25, 0.05, calibrationSlowdown(current, baseline) ?? 1);
    expect(comparisons.filter((comparison) => comparison.status === "regression")).toHaveLength(1);
  });

  it("still flags genuine regressions on a slow runner", () => {
    const baseline = report([
      { suite: "calibration", name: "reference kernel", meanMs: 0.5 },
      { suite: "deliberation", name: "deliberate proposal", meanMs: 0.538 },
    ]);
    const current = report([
      { suite: "calibration", name: "reference kernel", meanMs: 0.775 },
      { suite: "deliberation", name: "deliberate proposal", meanMs: 1.61 }, // 3x — real regression
    ]);
    const slowdown = calibrationSlowdown(current, baseline) ?? 1;
    const comparisons = compareReports(current, baseline, 0.25, 0.05, slowdown);
    expect(comparisons.filter((comparison) => comparison.status === "regression")).toHaveLength(1);
  });
});
