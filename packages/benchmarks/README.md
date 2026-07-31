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

`bench:compare` writes the baseline on first use, then fails (exit 1) when a
mean duration grows by more than the threshold. Both files stay untracked —
compare runs from the same machine, since absolute timings are not portable
across CI runners.

| Variable | Default | Meaning |
|----------|---------|---------|
| `BENCH_RESULTS` | `benchmark-results.json` | Current run |
| `BENCH_BASELINE` | `benchmark-baseline.json` | Reference run |
| `BENCH_THRESHOLD` | `0.25` | Regression threshold (ratio) |

## Suites

- **deliberation** — proposal creation, swarm deliberation with the 7 default
  agents, control gates, and the pure tally/scoring path.
- **persistence** — in-memory vs file repository, small vs 500-proposal state,
  no-op persists, and cold reload.
- **artefacts** — single artefact, all 7 artefacts, batch generation, markdown
  rendering, delivery plan.

Agents run in-process (`benchmarkWorker`), so measurements reflect core
orchestration cost only — never model latency.
