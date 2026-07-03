---
"@guyghost/swarm-dao-core": patch
---

Persistence: skip rewriting unchanged JSON files in saveState()

`saveState()` now caches the last serialized content per file path and skips the
disk write when the content is unchanged. Previously every mutation (adding a
vote, storing an agent output, recording audit, storing a score/synthesis/plan)
rewrote `state.json` plus every proposal sidecar and every decision file — even
the ones that did not change. On the deliberation hot path, which triggers a
save ~6 times back-to-back, this removes the bulk of the redundant file writes
while keeping the on-disk bytes identical.
