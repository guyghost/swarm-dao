# ADR-005: Audit Log → Append-Only JSONL (Phase 2 of ADR-004)

## Status

Accepted (2026-09-18)

## Context

ADR-004 moved closed proposals and their satellite records out of `state.json`,
making persist cost O(open proposals + auditLog). With `auditLog` still inline,
a long-lived DAO re-serializes its entire governance trail on every persist.
Measured (2000 closed + 5000 audit entries): no-op persist 1.23 ms, of which
~90 % is the audit array inside `state.json` (1.3 MB).

Audit entries are append-only: every writer does
`state.auditLog.push({ id: state.nextAuditId++, … })`; nothing mutates or
removes entries. Readers (`getAuditLog`, `getAllAuditLog`, control/audit, CLI)
filter the in-memory merged state.

## Decision

Move `auditLog` to `.dao/audit.jsonl` — one compact JSON `AuditEntry` per line,
append-only:

- **In-memory unchanged:** `state.auditLog` stays the full merged list;
  `partitionState` serializes `state.json` with an empty `auditLog`.
- **Append, never rewrite:** on persist, entries whose ids are not yet durable
  are appended in one `fs.appendFile`. The repository keeps an in-memory
  `persistedAuditIds` set (recovered at open by parsing the JSONL) so gaps,
  duplicates and legacy migration resolve exactly.
- **Ordering:** JSONL append happens *before* the `state.json` write (same
  critical section). A crash in between leaves the trail durably ahead of the
  state — accepted governance semantics (a recorded action must not vanish);
  the next open dedupes by entry id, so a re-append after recovery is harmless.
- **Tolerant parsing:** empty lines and corrupt lines (including a torn final
  line from a mid-append crash) are skipped and counted; the persistence
  adapters log a warning when lines were skipped. Audit entries are
  deduplicated by id on load, and entries without a usable id are treated as
  corrupt rather than folded into the trail.
- **Migration:** legacy inline `auditLog` in `state.json` merges into memory at
  open and moves to the JSONL on the first writing persist. Read-only commands
  never write and still see everything.
- **Counters:** `repairCounters` runs after the audit merge, so `nextAuditId`
  clears the highest JSONL id (issue #157 invariant).

## Consequences

- **Consequences:** no-op persist becomes truly O(open): measured 1.23 ms →
  0.33 ms in the 2000-closed + 5000-audit regime.
- Appending an audit entry costs one line-sized append instead of a full
  state rewrite.
- Old binaries reading a partitioned repo see no audit trail (same version-
  skew caveat as ADR-004).
- `audit.jsonl` is authoritative for the durable trail; truncating it loses
  history (documented).
- Appends are fsynced (file, then directory) before `state.json` is renamed,
  so a crash cannot commit state whose audit line is still only in the page cache.
- A torn or corrupt line is still skipped on load. The next persist rewrites
  a clean trail. The file is also rewritten every 2000 new entries so damage
  cannot accumulate; between rewrites, persist stays an append.

## Test plan

Round-trip through the JSONL; dedupe by id; torn/corrupt line tolerance;
append-only growth (prefix preserved); legacy inline migration; counter repair
past the JSONL max id; no-op byte-stability; `loadState` compat path; audit-
only change appends without rewriting the file.
