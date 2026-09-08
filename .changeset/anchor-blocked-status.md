---
"@guyghost/swarm-dao-core": patch
"@guyghost/swarm-dao-improvement": patch
---

Blocked anchor status: an anchor whose verification command could not run to a verdict (runner timeout kill, sandbox launch refusal, missing binary) is now recorded as `blocked` instead of `failed` — measured failures and unmeasured environments are no longer conflated. Any `blocked` required anchor routes `EVALUATE` to the cycle's `blocked` terminal (before drift adjustment and retrying), and the series halts (`CYCLE_BLOCKED` → `halted`) for a human restart, so retries are never burned against a broken environment. Implemented through the owner-approved improvement-loop model (graph run `anchor-blocked-status`, model hash `25b3e39cf2ed033de90230b69ef8cc40dc3898eae99ac862963a5c5f1f2d439a`, state `succeeded`). Closes #145.
