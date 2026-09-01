---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-improvement": patch
---

Anchor results are immutable within the current attempt and refreshable across an authorized retry (Graph Engineering run `anchor-retry-refresh`, model hash 179b3a29, human-approved).

- Machine (`recordAnchorOnce`): an anchor recorded at an earlier attempt is re-recorded when its command runs again at the current attempt; same-attempt duplicates stay rejected. A surviving anchor retained in a failed state no longer dead-ends every retry (dogfood-003 c7: an infra-failed `frozen-set-intact` survived each retry and could never be re-recorded).
- Executor: grounding skips anchors already recorded at the current attempt (crash-resume idempotency — a re-entered grounding run no longer re-runs and throws on immutable results) and re-runs retained ones.
- Model docs: `models/improvement-loop.md` anchor rules updated; the gap is closed in `improvement-loop.review.md`.
- Repairs the `graph:*` and `product:*` CLI shims (re-export does not bind a local name for `import.meta.main`; `graph:init` had never run since the packages move).
