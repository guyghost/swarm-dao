import { describe, expect, it } from "bun:test";
import { parseArgs, SUITES } from "../benchmarks/index.js";
import { compareReports, formatComparisons } from "../scripts/compare-benchmarks.js";
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
    expect(SUITES.map((suite) => suite.name)).toEqual(["deliberation", "persistence", "artefacts"]);
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

  it("marks measurements missing from the baseline as new", () => {
    const comparisons = compareReports(report([{ suite: "s", name: "b", meanMs: 3 }]), report([]), 0.25);
    expect(comparisons[0]?.status).toBe("new");
    expect(comparisons[0]?.baselineMs).toBeNull();
  });
});
