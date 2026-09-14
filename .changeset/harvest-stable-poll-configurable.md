---
"@guyghost/swarm-dao-improvement": patch
"@guyghost/swarm-dao-cli": patch
---

Stop the harvest stable-poll killing workers that run long uncached commands (issue #180): four identical polls (≈20 s of transcript silence) misread a worker mid-command — e.g. a drift auditor re-running an uncached full test suite — as "settled without a valid contract", failing all 3 attempts. The stable-settle window is now `DEFAULT_STABLE_POLLS` (36 ≈ 3 min at the default 5 s poll) and the default attempt deadline rose to the 15 min ceiling; both are tunable via the new `worker.stablePolls` / `worker.pollIntervalMs` / `worker.timeoutMs` fields of `.dao/improvement.json` (non-numeric values are refused, out-of-range numbers clamped). Cost when an agent genuinely settles with prose: the stable window per attempt.
