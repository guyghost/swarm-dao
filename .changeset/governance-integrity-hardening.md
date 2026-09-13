---
"@guyghost/swarm-dao-core": major
"@guyghost/swarm-dao-cli": patch
"@guyghost/swarm-dao-mcp": patch
"@guyghost/swarm-dao-herdr-adapter": minor
"@guyghost/swarm-dao-tmux-adapter": minor
---

Governance integrity hardening (issues #153–#169).

- Core: revision-based optimistic concurrency (stateRevision) — a stale writer now fails persist() instead of silently dropping votes; both load paths repair ID counters; corrupt state.json gets a clear error plus an automatic backup before shape repair; token-owned lock files with heartbeat; atomic writes for contained files and the GitHub config; updateStorageSettings runs under the DAO lock; ship-audit claim locks are reclaimable when their owner is gone.
- Core: tallyVotes grounds the quorum denominator in the configured council (silent members carry their configured weight), never undercuts the votes cast, and compares thresholds as exact fractions — Math.round no longer decides approvals.
- Core: addVote replaces the same agent's prior vote, refuses votes outside open/deliberating and bounds weight (config.maxVoteWeight, default 3).
- Core: proposal machine guards recompute the tally and replay the gates instead of trusting the event payload; guarded events require config.
- Core: deliberation rollback on worker failure (ERROR + persist + audit) and a new ABORT_DELIBERATION transition (deliberating → open); deliberationStartedAt recorded.
- Core: delegation-closed gate consults a persisted cross-process in-flight marker, so INV-8 can actually block.
- Core: risk-threshold gate fails closed when no risk scores were produced; control failures transition failed by default (failOnGateFailure opt-out); dependency cycles rejected at creation; dependency-readiness uses transitive closure; cascade ship reports its shipped prefix on failure.
- Core: GitHub owner/repo/headBranch validated before persistence and before any gh api call.
- MCP: declared input schemas are enforced at runtime via a single schema registry (no more NaN ids, unbounded scores or forged event enums).
- herdr: contained path resolution returns the resolved path (TOCTOU symlink escape closed).
- CLI/tmux/herdr: HostAdapter.exec routes through the core's shell-free execCommand.
