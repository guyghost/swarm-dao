#!/usr/bin/env bun
// Compare a benchmark run against the committed baseline and fail on regressions.

import { promises as fs } from "node:fs";
import type { BenchmarkMeasurement, BenchmarkReport } from "../src/harness.js";

const DEFAULT_RESULTS = "benchmark-results.json";
const DEFAULT_BASELINE = "benchmark-baseline.json";
const DEFAULT_THRESHOLD = 0.25;

export type ComparisonStatus = "ok" | "new" | "regression";

export interface Comparison {
  suite: string;
  name: string;
  currentMs: number;
  baselineMs: number | null;
  changeRatio: number | null;
  status: ComparisonStatus;
}

function key(measurement: { suite: string; name: string }): string {
  return `${measurement.suite}/${measurement.name}`;
}

export function compareReports(
  current: BenchmarkReport,
  baseline: BenchmarkReport | null,
  threshold: number,
): Comparison[] {
  const baselineByKey = new Map<string, BenchmarkMeasurement>(
    (baseline?.measurements ?? []).map((measurement) => [key(measurement), measurement]),
  );

  return current.measurements.map((measurement) => {
    const previous = baselineByKey.get(key(measurement));
    if (!previous || previous.meanMs === 0) {
      return {
        suite: measurement.suite,
        name: measurement.name,
        currentMs: measurement.meanMs,
        baselineMs: previous?.meanMs ?? null,
        changeRatio: null,
        status: "new" as const,
      };
    }
    const changeRatio = (measurement.meanMs - previous.meanMs) / previous.meanMs;
    return {
      suite: measurement.suite,
      name: measurement.name,
      currentMs: measurement.meanMs,
      baselineMs: previous.meanMs,
      changeRatio,
      status: changeRatio > threshold ? ("regression" as const) : ("ok" as const),
    };
  });
}

export function formatComparisons(comparisons: Comparison[]): string {
  return comparisons
    .map((comparison) => {
      const change = comparison.changeRatio === null ? "new" : `${(comparison.changeRatio * 100).toFixed(1)}%`;
      const baseline = comparison.baselineMs === null ? "—" : `${comparison.baselineMs.toFixed(3)}ms`;
      return `${comparison.status.toUpperCase().padEnd(11)} ${comparison.suite}/${comparison.name} — ${comparison.currentMs.toFixed(3)}ms vs ${baseline} (${change})`;
    })
    .join("\n");
}

async function readReport(file: string): Promise<BenchmarkReport | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as BenchmarkReport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const resultsFile = process.env.BENCH_RESULTS ?? DEFAULT_RESULTS;
  const baselineFile = process.env.BENCH_BASELINE ?? DEFAULT_BASELINE;
  const threshold = Number(process.env.BENCH_THRESHOLD ?? DEFAULT_THRESHOLD);

  const current = await readReport(resultsFile);
  if (!current) {
    console.error(`No benchmark results at ${resultsFile}. Run \`bun run bench:ci\` first.`);
    process.exit(1);
  }

  const baseline = await readReport(baselineFile);
  if (!baseline) {
    await fs.writeFile(baselineFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(`No baseline found — wrote ${baselineFile} from the current run.`);
    return;
  }

  const comparisons = compareReports(current, baseline, threshold);
  console.log(formatComparisons(comparisons));

  const regressions = comparisons.filter((comparison) => comparison.status === "regression");
  if (regressions.length > 0) {
    console.error(`\n${regressions.length} regression(s) beyond ${(threshold * 100).toFixed(0)}%.`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
