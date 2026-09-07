---
"@guyghost/swarm-dao-benchmarks": minor
---

The calibrated benchmark gate now calibrates filesystem speed alongside CPU. A new `calibration-io` suite (`io kernel`: mkdir + small write, mirroring the persistence suite's syscalls) measures each runner's disk, and I/O-bound suites (`persistence`, `calibration-io`) scale their regression gate by that ratio instead of the CPU kernel — fixing the PR #133 incident where persist cases flagged at +60–106% while the CPU calibration was identical (GitHub runner fleet disk variance). Genuine I/O regressions still fail. Also adds a root `version` script (`changeset version && bun install --lockfile-only`) so Version Packages PRs carry an up-to-date `bun.lock` and no longer fail the frozen-lockfile CI install.
