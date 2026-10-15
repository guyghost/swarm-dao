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
export const CALIBRATION_IO_SUITE = "calibration-io";

/**
 * Suites dominated by filesystem syscalls (mkdir/write): their cost tracks
 * runner disk speed, which the pure-CPU kernel cannot see. These scale with
 * the I/O calibration kernel instead of the CPU one (PR #133 incident:
 * persistence cases flagged at +60–106% with a calibration-identical CPU).
 */
const IO_BOUND_SUITES = new Set(["persistence", CALIBRATION_IO_SUITE]);

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

// Average per-case minima, not run means: a kernel stall must not loosen the gate.
const meanSuiteMinimumMs = (report: BenchmarkReport | null, suite: string): number | null => {
  const entries = (report?.measurements ?? []).filter((measurement) => measurement.suite === suite);
  if (entries.length === 0) return null;
  return entries.reduce((sum, measurement) => sum + measurement.minMs, 0) / entries.length;
};

/**
 * Ratio of current to baseline kernel time for a calibration suite. This is
 * pure runner speed: shared CI runners routinely run whole jobs 30–60% slower,
 * which used to surface as fleet-wide fake regressions. Returns null when
 * either report has no calibration data (a pre-calibration baseline) so the
 * caller can replace the baseline instead of comparing apples to oranges.
 */
export function kernelSlowdown(
  current: BenchmarkReport,
  baseline: BenchmarkReport | null,
  calibrationSuite: string,
  maxSlowdown: number = MAX_SLOWDOWN,
): number | null {
  const currentMs = meanSuiteMinimumMs(current, calibrationSuite);
  const baselineMs = meanSuiteMinimumMs(baseline, calibrationSuite);
  if (currentMs === null || baselineMs === null || baselineMs === 0 || currentMs === 0) return null;
  if (!Number.isFinite(currentMs / baselineMs)) return null;
  // A faster runner never tightens the gate; a slower one relaxes it, capped.
  return Math.min(Math.max(currentMs / baselineMs, 1), maxSlowdown);
}

export function calibrationSlowdown(
  current: BenchmarkReport,
  baseline: BenchmarkReport | null,
  maxSlowdown: number = MAX_SLOWDOWN,
): number | null {
  return kernelSlowdown(current, baseline, CALIBRATION_SUITE, maxSlowdown);
}

export function ioCalibrationSlowdown(
  current: BenchmarkReport,
  baseline: BenchmarkReport | null,
  maxSlowdown: number = MAX_SLOWDOWN,
): number | null {
  return kernelSlowdown(current, baseline, CALIBRATION_IO_SUITE, maxSlowdown);
}

function relativeChange(currentMs: number, baselineMs: number): number {
  // Sub-microsecond minima round to zero. This is still a measured baseline,
  // not a new case: any positive increase must clear the absolute noise floor.
  if (baselineMs === 0) return currentMs > 0 ? Number.POSITIVE_INFINITY : 0;
  return (currentMs - baselineMs) / baselineMs;
}

export function isRegression(
  currentMs: number,
  baselineMs: number,
  allowedThreshold: number,
  allowedFloorMs: number,
): boolean {
  if (baselineMs < 0) return false;
  const changeRatio = relativeChange(currentMs, baselineMs);
  return changeRatio > allowedThreshold && currentMs - baselineMs > allowedFloorMs;
}

export function compareReports(
  current: BenchmarkReport,
  baseline: BenchmarkReport | null,
  threshold: number,
  floorMs: number = DEFAULT_FLOOR_MS,
  slowdown: number = 1,
  ioSlowdown: number = 1,
): Comparison[] {
  const baselineByKey = new Map<string, BenchmarkMeasurement>(
    (baseline?.measurements ?? []).map((measurement) => [key(measurement), measurement]),
  );

  return current.measurements.map((measurement) => {
    // I/O-bound suites scale with the filesystem kernel, the rest with CPU.
    const suiteSlowdown = IO_BOUND_SUITES.has(measurement.suite) ? ioSlowdown : slowdown;
    const allowedThreshold = threshold + (suiteSlowdown - 1);
    const allowedFloor = floorMs * suiteSlowdown;
    const previous = baselineByKey.get(key(measurement));
    if (!previous) {
      return {
        suite: measurement.suite,
        name: measurement.name,
        currentMs: measurement.minMs,
        baselineMs: null,
        changeRatio: null,
        status: "new" as const,
      };
    }
    const changeRatio = relativeChange(measurement.minMs, previous.minMs);
    // A regression requires BOTH the relative threshold and the absolute
    // noise floor — and both scale with the measured runner slowdown for the
    // case's resource class (CPU vs filesystem), so a slow shared runner
    // cannot fail the whole fleet while a genuine algorithmic regression
    // (relative AND absolute, way beyond both scaled gates) still fails.
    const regressed = isRegression(measurement.minMs, previous.minMs, allowedThreshold, allowedFloor);
    return {
      suite: measurement.suite,
      name: measurement.name,
      currentMs: measurement.minMs,
      baselineMs: previous.minMs,
      changeRatio,
      status: regressed ? ("regression" as const) : ("ok" as const),
    };
  });
}

export function formatComparisons(comparisons: Comparison[]): string {
  return comparisons
    .map((comparison) => {
      const change =
        comparison.changeRatio === null
          ? "new"
          : Number.isFinite(comparison.changeRatio)
            ? `${(comparison.changeRatio * 100).toFixed(1)}%`
            : "n/a";
      const baseline = comparison.baselineMs === null ? "—" : `${comparison.baselineMs.toFixed(3)}ms`;
      return `${comparison.status.toUpperCase().padEnd(11)} ${comparison.suite}/${comparison.name} — ${comparison.currentMs.toFixed(3)}ms vs ${baseline} (${change})`;
    })
    .join("\n");
}

/**
 * Re-measure one benchmark case in isolation, `attempts` times, and report each
 * run's minimum iteration, the same statistic used for the baseline and first
 * comparison. More iterations give additive filesystem/GC stalls more chances
 * to clear; taking a minimum of run means still retains a stall in every run
 * (issue #218). Suite state is re-seeded before every attempt: stateful suites
 * cap total runs between setups — the deliberation pool holds 200 proposals,
 * consumed one per iteration, which 5×100 exhausted mid-adjudication on CI.
 * Every attempt starts from identical state, keeping the minima comparable.
 * Returns an empty array when the case no longer exists (renamed/removed).
 */
export async function reMeasureCase(
  suiteName: string,
  caseName: string,
  attempts = 5,
  iterations = 100,
): Promise<number[]> {
  const suite = SUITES.find((candidate) => candidate.name === suiteName);
  const benchmark = suite?.cases.find((candidate) => candidate.name === caseName);
  if (!suite || !benchmark) return [];
  const minima: number[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    await suite.setup?.();
    try {
      minima.push((await runCase(suite, benchmark, { iterations })).minMs);
    } finally {
      await suite.teardown?.();
    }
  }
  return minima;
}

export interface AdjudicationResult {
  /** Flags whose best re-measured iteration still sits beyond the calibrated gates. */
  confirmed: Comparison[];
  /** Flags dismissed as runner noise because the re-measurement fell inside. */
  dismissed: Array<Comparison & { reMeasuredMs: number }>;
}

/**
 * Second-chance gate: a flag must reproduce on isolated re-measurement before
 * it may fail CI. The same calibrated gates (relative AND absolute) apply to
 * the best minimum iteration across attempts, compared with the baseline's
 * minimum iteration. Adjudication never loosens the definition of a regression.
 *
 * Additive noise (filesystem stalls, GC pauses, scheduler bursts) can inflate
 * every run mean, so even the minimum of five means can confirm a false
 * regression (issue #218). Using iteration minima at every stage measures
 * repeatable best-case cost; mean and p95 remain available as diagnostics.
 */
export async function adjudicateRegressions(
  regressions: Comparison[],
  baseline: BenchmarkReport,
  gates: { threshold: number; floorMs: number; slowdown: number; ioSlowdown: number },
  reMeasure: (suite: string, name: string) => Promise<number[]> = reMeasureCase,
): Promise<AdjudicationResult> {
  const gatesFor = (suite: string): { allowedThreshold: number; allowedFloor: number } => {
    const suiteSlowdown = IO_BOUND_SUITES.has(suite) ? gates.ioSlowdown : gates.slowdown;
    return {
      allowedThreshold: gates.threshold + (suiteSlowdown - 1),
      allowedFloor: gates.floorMs * suiteSlowdown,
    };
  };
  const baselineByKey = new Map<string, BenchmarkMeasurement>(
    (baseline.measurements ?? []).map((measurement) => [key(measurement), measurement]),
  );

  const confirmed: Comparison[] = [];
  const dismissed: AdjudicationResult["dismissed"] = [];
  for (const regression of regressions) {
    const baselineMs = baselineByKey.get(key(regression))?.minMs;
    const minima = await reMeasure(regression.suite, regression.name);
    // Nothing to re-measure, or no baseline entry to adjudicate against (e.g.
    // the case was renamed between baseline and run, or a malformed baseline):
    // keep the honest failure — dismissal requires reproduced evidence, not
    // missing data (Copilot review on #81).
    const { allowedThreshold, allowedFloor } = gatesFor(regression.suite);
    if (
      minima.length === 0 ||
      baselineMs === undefined ||
      baselineMs < 0 ||
      isRegression(Math.min(...minima), baselineMs, allowedThreshold, allowedFloor)
    ) {
      confirmed.push(regression);
    } else {
      dismissed.push({ ...regression, reMeasuredMs: Math.min(...minima) });
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
  // The I/O kernel arrived after the CPU one. A baseline without I/O data
  // cannot gate fs-bound suites apples to apples — replace it from the
  // current run (same policy as the pre-CPU-calibration path above), so the
  // next comparison is fully calibrated.
  const ioSlowdown = ioCalibrationSlowdown(current, baseline);
  if (ioSlowdown === null) {
    await fs.writeFile(baselineFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(`Baseline has no I/O calibration data — replaced ${baselineFile} from the current run.`);
    return;
  }

  const comparisons = compareReports(current, baseline, threshold, floorMs, slowdown, ioSlowdown);
  console.log("Comparing minimum iteration durations (minMs).");
  console.log(formatComparisons(comparisons));
  console.log(
    `\ncalibration: cpu slowdown x${slowdown.toFixed(2)} -> gate at >${((threshold + slowdown - 1) * 100).toFixed(0)}% and ${(floorMs * slowdown).toFixed(3)}ms; io slowdown x${ioSlowdown.toFixed(2)} -> gate at >${((threshold + ioSlowdown - 1) * 100).toFixed(0)}% and ${(floorMs * ioSlowdown).toFixed(3)}ms.`,
  );

  const regressions = comparisons.filter((comparison) => comparison.status === "regression");
  if (regressions.length === 0) return;

  const { confirmed, dismissed } = await adjudicateRegressions(regressions, baseline, {
    threshold,
    floorMs,
    slowdown,
    ioSlowdown,
  });
  for (const flake of dismissed) {
    console.log(
      `ADJUDICATED  ${flake.suite}/${flake.name} — best re-measured iteration ${flake.reMeasuredMs.toFixed(3)}ms vs ${flake.baselineMs?.toFixed(3)}ms is inside the gate; dismissed as runner noise.`,
    );
  }
  if (confirmed.length === 0) {
    console.log(`\n${dismissed.length} flagged bench(es) did not reproduce on re-measurement; gate passed.`);
    return;
  }
  console.error(
    `\n${confirmed.length} regression(s) reproduced beyond their calibrated gates (cpu x${slowdown.toFixed(2)}, io x${ioSlowdown.toFixed(2)}).`,
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
