# Swarm DAO Benchmarks

Performance baselines for the core governance hot paths. `bun:test` has no
`bench` primitive, so suites are plain data (`BenchmarkSuite`) executed by the
harness in `src/harness.ts`, which owns warmup, timing and statistics.

```
src/harness.ts          # warmup / timing / statistics, no dependencies
src/fixtures.ts         # in-process agents, proposals and repositories
benchmarks/index.ts     # CLI entry point (`--json`, `--iterations`, `--filter`)
benchmarks/*.benchmark.ts
scripts/compare-benchmarks.ts  # regression detection against a baseline
tests/harness.test.ts   # the harness and the comparison logic are unit-tested
```

## Running

```bash
bun run bench                         # human-readable table
bun run bench -- --filter artefacts   # one suite
bun run bench -- --iterations 100     # override the iteration count
bun run bench:ci                      # writes benchmark-results.json
bun run bench:compare                 # compares results against benchmark-baseline.json
```

`bench:compare` writes the baseline on first use, then compares each case's
**minimum iteration duration (`minMs`)** with the baseline's minimum. A flag
must exceed both the relative threshold and the absolute noise floor. Each
flagged case is re-measured in isolation (5 attempts × 100 iterations, with
fresh suite state per attempt); the gate fails (exit 1) only if even the best
iteration remains beyond both gates. Cases that cannot be re-measured remain
failures rather than being silently dismissed.

The minimum resists additive filesystem, GC and scheduling stalls inside an
attempt, including a stall in every attempt that would inflate even the best
run mean (issue #218). It gates repeatable best-case cost; mean, p95 and
throughput remain available for diagnosing typical/tail latency. Sustained
regressions that slow every iteration still fail. Both the initial comparison
and adjudication use the same statistic and thresholds; no extra I/O allowance
is added. Existing JSON baselines already contain `minMs` and remain compatible.
When a baseline minimum rounds to zero, positive changes are still gated by
the calibrated absolute floor; the case is not treated as new.

CPU and I/O calibration kernels also use iteration minima. A slower kernel
relaxes its resource class's relative threshold by `slowdown - 1` and multiplies
the absolute floor by `slowdown`, capped at 3× and never tightened for a faster
runner. Persistence uses the I/O kernel; other suites use CPU. Both files stay
untracked; prefer runs from the same machine, since calibration only mitigates
differences between shared CI runners.

| Variable | Default | Meaning |
|----------|---------|---------|
| `BENCH_RESULTS` | `benchmark-results.json` | Current run |
| `BENCH_BASELINE` | `benchmark-baseline.json` | Reference run |
| `BENCH_THRESHOLD` | `0.25` | Regression threshold (ratio) |
| `BENCH_FLOOR_MS` | `0.05` | Absolute regression noise floor (milliseconds) |

## Suites

- **deliberation** — proposal creation, swarm deliberation with the 8 default
  agents, control gates, and the pure tally/scoring path.
- **persistence** — in-memory vs file repository, small vs 500-proposal state,
  no-op persists, and cold reload.
- **artefacts** — single artefact, all 7 artefacts, batch generation, markdown
  rendering, delivery plan.

Agents run in-process (`benchmarkWorker`), so measurements reflect core
orchestration cost only — never model latency.
