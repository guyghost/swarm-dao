---
"@guyghost/swarm-dao-core": patch
"@guyghost/swarm-dao-benchmarks": patch
---

Skip the O(proposals) decision sweep when a persist has nothing to write.

Decision records are a pure function of `state.proposals`, so when the
serialized state matches the last write the per-decision checks cannot
change: `hasPendingWrites` short-circuits after the state check and
`persistDecisions` returns early when the serialized index matches the
write cache. A `decisionsPending` flag forces the full sweep after a
persist that failed mid-way, keeping failure-retry behavior identical.

Measured A/B (bun 1.4.2, no-op persist, 2000 closed proposals):
~9.8–11.5 ms → ~8.8–9.1 ms. Adds a persistence benchmark case for the
unchanged-state-with-closed-proposals regime.
