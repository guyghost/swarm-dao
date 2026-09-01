---
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-core": patch
---

CLI operator experience: human gates get dedicated commands, status becomes human-readable.

- New gate commands replace hand-written JSON signal files (each shows the exact decision inputs and requires confirmation; `--yes` for reviewed non-interactive use): `approve`/`reject` (graph MODEL_APPROVED/MODEL_REJECTED with the exact model hash), `improve retry` (RETRY_AUTHORIZED), `improve retry-workers`, `improve restart`, `improve cancel --reason`, `improve reference --decision approve|reject` (adjusting cycles).
- `improve status` and `graph status` render human-readable output by default (state glyphs, hashes, anchors, suggested next command); `--json` keeps the raw machine snapshot.
- `improve cycles --series-id` lists the cycle history (outcome, attempt, metric, drift, arbitration, duration from the journal).
- `next` shows what the machines need from you now: pending human gates with runnable commands, plus live workflows (cooldown countdowns, in-flight runs).
- Evidence roots resolve across `.dao/*` and `evidence/*` for reads (a started series beats a stale idle snapshot materialized by an unrooted `improve status`), killing silent `idle` answers; creation effects keep the strict root.
- Attention suggestions now point at the new gate commands.
