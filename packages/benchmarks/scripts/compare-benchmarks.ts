#!/usr/bin/env bun
// Compare a benchmark run against the committed baseline and fail on regressions
// that reproduce. A single flagging run is adjudicated: the flagged case is
// re-measured in isolation and only a reproduced flag fails the gate (PR #79
// finding — sub-ms micro-benches flared 3x on one shared runner, then passed).

import { promises as fs } from "node:fs";
import { SUITES } from "../benchmarks/index.js";
import { type BenchmarkMeasurement, type BenchmarkReport, runCase } from "../src/harness.js";

const DEFAULT_RESULTS = "benchmark-results.json";
const DEFAULT_BASELINE = "benchmark-baseline.json";
const DEFAULT_THRESHOLD = 0.25;
/** Absolute noise floor: timer jitter on microsecond-scale cases must not fail CI. */
const DEFAULT_FLOOR_MS = 0.05;
/** The calibration kernel caps how much runner slowness may relax the gate. */
const MAX_SLOWDOWN = 3;

export const CALIBRATION_SUITE = "calibration";

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

const meanCalibrationMs = (report: BenchmarkReport | null): number | null => {
  const entries = (report?.measurements ?? []).filter((measurement) => measurement.suite === CALIBRATION_SUITE);
  if (entries.length === 0) return null;
  return entries.reduce((sum, measurement) => sum + measurement.meanMs, 0) / entries.length;
};

/**
 * Ratio of current to baseline calibration-kernel time. This is pure runner
 * speed: shared CI runners routinely run whole jobs 30–60% slower, which used
 * to surface as fleet-wide fake regressions. Returns null when either report
 * has no calibration data (a pre-calibration baseline) so the caller can
 * replace the baseline instead of comparing apples to oranges.
 */
export function calibrationSlowdown(
  current: BenchmarkReport,
  baseline: BenchmarkReport | null,
  maxSlowdown: number = MAX_SLOWDOWN,
): number | null {
  const currentMs = meanCalibrationMs(current);
  const baselineMs = meanCalibrationMs(baseline);
  if (currentMs === null || baselineMs === null || baselineMs === 0 || currentMs === 0) return null;
  if (!Number.isFinite(currentMs / baselineMs)) return null;
  // A faster runner never tightens the gate; a slower one relaxes it, capped.
  return Math.min(Math.max(currentMs / baselineMs, 1), maxSlowdown);
}

export function isRegression(
  currentMs: number,
  baselineMs: number,
  allowedThreshold: number,
  allowedFloorMs: number,
): boolean {
  if (baselineMs <= 0) return false;
  const changeRatio = (currentMs - baselineMs) / baselineMs;
  return changeRatio > allowedThreshold && currentMs - baselineMs > allowedFloorMs;
}

export function compareReports(
  current: BenchmarkReport,
  baseline: BenchmarkReport | null,
  threshold: number,
  floorMs: number = DEFAULT_FLOOR_MS,
  slowdown: number = 1,
): Comparison[] {
  const allowedThreshold = threshold + (slowdown - 1);
  const allowedFloor = floorMs * slowdown;
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
    // A regression requires BOTH the relative threshold and the absolute
    // noise floor — and both scale with measured runner slowdown, so a slow
    // shared runner cannot fail the whole fleet while a genuine algorithmic
    // regression (relative AND absolute, way beyond both scaled gates) still
    // fails on any runner.
    const regressed = isRegression(measurement.meanMs, previous.meanMs, allowedThreshold, allowedFloor);
    return {
      suite: measurement.suite,
      name: measurement.name,
      currentMs: measurement.meanMs,
      baselineMs: previous.meanMs,
      changeRatio,
      status: regressed ? ("regression" as const) : ("ok" as const),
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

const median = (values: number[]): number =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

/**
 * Re-measure one benchmark case in isolation, `attempts` times, and report each
 * run's mean. Uses a higher iteration count than the suite default so the
 * re-measurement is steadier than the run that raised the flag. Returns an
 * empty array when the case no longer exists (renamed/removed).
 */
export async function reMeasureCase(
  suiteName: string,
  caseName: string,
  attempts = 3,
  iterations = 50,
): Promise<number[]> {
  const suite = SUITES.find((candidate) => candidate.name === suiteName);
  const benchmark = suite?.cases.find((candidate) => candidate.name === caseName);
  if (!suite || !benchmark) return [];
  await suite.setup?.();
  try {
    const means: number[] = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      means.push((await runCase(suite, benchmark, { iterations })).meanMs);
    }
    return means;
  } finally {
    await suite.teardown?.();
  }
}

export interface AdjudicationResult {
  /** Flags whose re-measured median still sits beyond the calibrated gates. */
  confirmed: Comparison[];
  /** Flags dismissed as runner noise because the re-measurement fell inside. */
  dismissed: Array<Comparison & { reMeasuredMs: number }>;
}

/**
 * Second-chance gate: a flag must reproduce on isolated re-measurement before
 * it may fail CI. The same calibrated gates (relative AND absolute) apply to
 * the re-measured median — adjudication never loosens the definition of a
 * regression, it only demands the evidence reproduce.
 */
export async function adjudicateRegressions(
  regressions: Comparison[],
  baseline: BenchmarkReport,
  gates: { threshold: number; floorMs: number; slowdown: number },
  reMeasure: (suite: string, name: string) => Promise<number[]> = reMeasureCase,
): Promise<AdjudicationResult> {
  const allowedThreshold = gates.threshold + (gates.slowdown - 1);
  const allowedFloor = gates.floorMs * gates.slowdown;
  const baselineByKey = new Map<string, BenchmarkMeasurement>(
    (baseline.measurements ?? []).map((measurement) => [key(measurement), measurement]),
  );

  const confirmed: Comparison[] = [];
  const dismissed: AdjudicationResult["dismissed"] = [];
  for (const regression of regressions) {
    const baselineMs = baselineByKey.get(key(regression))?.meanMs ?? 0;
    const means = await reMeasure(regression.suite, regression.name);
    // Nothing to re-measure (renamed or removed case): keep the honest failure.
    if (means.length === 0 || isRegression(median(means), baselineMs, allowedThreshold, allowedFloor)) {
      confirmed.push(regression);
    } else {
      dismissed.push({ ...regression, reMeasuredMs: median(means) });
    }
  }
  return { confirmed, dismissed };
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
  const floorMs = Number(process.env.BENCH_FLOOR_MS ?? DEFAULT_FLOOR_MS);

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

  // A baseline from before the calibration kernel existed cannot be compared
  // against a calibrated run: replace it so the next comparison is apples to
  // apples. This also makes the first CI run after this change green.
  const slowdown = calibrationSlowdown(current, baseline);
  if (slowdown === null) {
    await fs.writeFile(baselineFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(`Baseline has no calibration data — replaced ${baselineFile} from the current run.`);
    return;
  }

  const comparisons = compareReports(current, baseline, threshold, floorMs, slowdown);
  console.log(formatComparisons(comparisons));
  console.log(
    `\ncalibration: runner slowdown x${slowdown.toFixed(2)} -> gate at >${((threshold + slowdown - 1) * 100).toFixed(0)}% and ${(floorMs * slowdown).toFixed(3)}ms.`,
  );

  const regressions = comparisons.filter((comparison) => comparison.status === "regression");
  if (regressions.length === 0) return;

  const { confirmed, dismissed } = await adjudicateRegressions(regressions, baseline, { threshold, floorMs, slowdown });
  for (const flake of dismissed) {
    console.log(
      `ADJUDICATED  ${flake.suite}/${flake.name} — re-measured median ${flake.reMeasuredMs.toFixed(3)}ms vs ${flake.baselineMs?.toFixed(3)}ms is inside the gate; dismissed as runner noise.`,
    );
  }
  if (confirmed.length === 0) {
    console.log(`\n${dismissed.length} flagged bench(es) did not reproduce on re-measurement; gate passed.`);
    return;
  }
  console.error(
    `\n${confirmed.length} regression(s) reproduced beyond ${((threshold + slowdown - 1) * 100).toFixed(0)}% and ${(floorMs * slowdown).toFixed(3)}ms.`,
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
