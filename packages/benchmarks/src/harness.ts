// ============================================================
// Swarm DAO Benchmarks — minimal measurement harness
// ============================================================
// `bun:test` has no `bench` primitive, so suites are plain data and this
// harness owns warmup, timing and statistics. Keeping it dependency-free means
// the same suites run locally, in CI, and from the regression comparison.

export interface BenchmarkCase {
  name: string;
  /** Measured iterations. Defaults to the suite value, then to 25. */
  iterations?: number;
  /** Unmeasured iterations run first to let the JIT settle. Defaults to 10% of `iterations`. */
  warmupIterations?: number;
  run: () => Promise<void> | void;
}

export interface BenchmarkSuite {
  name: string;
  iterations?: number;
  warmupIterations?: number;
  setup?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  cases: BenchmarkCase[];
}

export interface BenchmarkMeasurement {
  suite: string;
  name: string;
  iterations: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  opsPerSecond: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  runtime: string;
  measurements: BenchmarkMeasurement[];
}

export interface RunOptions {
  /** Overrides the iteration count declared by suites and cases. */
  iterations?: number;
  onProgress?: (measurement: BenchmarkMeasurement) => void;
}

const DEFAULT_ITERATIONS = 25;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarize(suite: string, name: string, durationsMs: number[]): BenchmarkMeasurement {
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const total = sorted.reduce((sum, duration) => sum + duration, 0);
  const meanMs = total / (sorted.length || 1);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    suite,
    name,
    iterations: sorted.length,
    meanMs: round(meanMs),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    p95Ms: round(sorted[Math.max(0, p95Index)] ?? 0),
    opsPerSecond: meanMs > 0 ? round(1000 / meanMs) : 0,
  };
}

export async function runCase(suite: BenchmarkSuite, benchmark: BenchmarkCase, options: RunOptions = {}) {
  const iterations = Math.max(1, options.iterations ?? benchmark.iterations ?? suite.iterations ?? DEFAULT_ITERATIONS);
  const warmup = Math.max(
    0,
    benchmark.warmupIterations ?? suite.warmupIterations ?? Math.min(5, Math.ceil(iterations / 10)),
  );

  for (let index = 0; index < warmup; index++) await benchmark.run();

  const durations: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    await benchmark.run();
    durations.push(performance.now() - startedAt);
  }
  return summarize(suite.name, benchmark.name, durations);
}

export async function runSuites(suites: BenchmarkSuite[], options: RunOptions = {}): Promise<BenchmarkReport> {
  const measurements: BenchmarkMeasurement[] = [];
  for (const suite of suites) {
    await suite.setup?.();
    try {
      for (const benchmark of suite.cases) {
        const measurement = await runCase(suite, benchmark, options);
        measurements.push(measurement);
        options.onProgress?.(measurement);
      }
    } finally {
      await suite.teardown?.();
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    measurements,
  };
}

export function formatReport(report: BenchmarkReport): string {
  const header = ["suite", "benchmark", "iterations", "mean (ms)", "p95 (ms)", "ops/s"];
  const rows = report.measurements.map((measurement) => [
    measurement.suite,
    measurement.name,
    String(measurement.iterations),
    measurement.meanMs.toFixed(3),
    measurement.p95Ms.toFixed(3),
    measurement.opsPerSecond.toFixed(1),
  ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}
