---
"@guyghost/swarm-dao-core": patch
"@guyghost/swarm-dao-improvement": patch
---

Two governance/quality fixes from the dogfood series.

**#141 — a gate failure no longer creates a final zombie.** A red-zone proposal checked without the mandatory dry-run dispatched `CONTROL_FAIL` into the final `failed` state: no re-check (even after completing the dry-run), no rejection, no annotation — only a duplicate proposal could move forward. Now `dao_control` refuses red-zone proposals without a completed dry-run *before* any transition ("run dao_dry_run proposalId=N first; no state change was made — the proposal stays approved"), and `failed` is no longer lifecycle-final: it carries exactly one closure transition, `REJECT → rejected`, so even a dead proposal gets an auditable reason. `executed`/`rejected` remain the only final statuses.

**#142 — optional metric contract.** `.dao/improvement.json` now accepts a `metric` section (`name` + `prompt`, optional `evidence`); when present, the sensor/counter-sensor prompts embed it verbatim so paired samples measure the same declared quantity across workers and cycles instead of each worker inventing its own "obvious" scope metric (which made arbitration decisions meaningless). A half-declared contract (name without prompt) fails config validation.
