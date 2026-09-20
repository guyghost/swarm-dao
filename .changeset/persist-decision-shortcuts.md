---
"@guyghost/swarm-dao-core": patch
---

Skip the O(proposals) decision sweep when a persist has nothing to write.

Decision records are a pure function of `state.proposals`, so when the
serialized state matches the last write the per-decision checks cannot
change: `hasPendingWrites` short-circuits after the state check and
`persistDecisions` returns early when the serialized index matches the
write cache. A `decisionsPending` flag forces the full sweep after a
persist that failed mid-way, keeping failure-retry behavior identical.

Standalone effect is within noise on the official suite; kept as
groundwork for ADR-004 (proposal archive), where the index guard keeps
archive-only persists free of the O(closed) decision sweep. Adds a
persistence benchmark case for the unchanged-state-with-closed-proposals
regime.
