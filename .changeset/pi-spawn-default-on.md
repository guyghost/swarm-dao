---
"@guyghost/swarm-dao-pi-adapter": patch
---

pi adapter spawns real agent subprocesses by default; simulated fallback is marked

`/dao roundtable` and deliberation produced canned, generic proposals because
real Pi subprocess spawning was opt-in behind the undocumented
`SWARM_DAO_ENABLE_PI_SPAWN=1` — the grounded project brief never reached a
model. Spawning is now the default (disable with `SWARM_DAO_DISABLE_PI_SPAWN=1`;
legacy `SWARM_DAO_ENABLE_PI_SPAWN=0` still disables). Whenever the simulated
fallback is used, its output is explicitly marked "⚠️ Simulated fallback
output" (round-table proposals created from it carry the marker) and a warn
log names the reason: spawning disabled, unresolvable model, or spawn failure.
