---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-benchmarks": patch
---

Move the audit trail to an append-only `audit.jsonl` (ADR-005, phase 2 of
ADR-004).

Audit entries now live in `.dao/audit.jsonl` — one compact JSON line each,
appended (never rewritten) on persist. `state.json` no longer carries the
trail, so no-op persist cost is O(open proposals) regardless of DAO age:
measured 1.23 ms → 0.33 ms with 5000 audit entries and no measurable change
to the other persistence cases.

- Load merges the trail into the in-memory `auditLog`, deduplicating by id;
  torn or corrupt lines (crash mid-append) are skipped with a warning and
  never fatal
- The trail is appended **before** `state.json` in the same locked section:
  a crash in between leaves the trail durably ahead of the state (a recorded
  action must not vanish); post-recovery re-appends are harmless
- Legacy inline `auditLog` migrates to the JSONL on the first writing
  persist; `nextAuditId` is repaired past the trail's max id
- `DaoStateRepositoryPort` API is unchanged
