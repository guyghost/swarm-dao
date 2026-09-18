# ADR-004: Proposal Archive — Partitioning `state.json` for O(open) Persist Cost

## Status

Accepted (2026-09-18)

## Context

### The measured problem

`FileDaoStateRepository.persist()` serializes the **entire** DAO state on every
write path, and the no-op change detector (`hasPendingWrites`) serializes the
entire state just to decide there is nothing to write. Measured (bun 1.4.2,
macOS arm64):

| Scenario | 500 proposals | 2000 closed proposals |
|---|---|---|
| `state.json` size | 328 KB | ~1.5–3 MB |
| no-op persist | 0.7 ms | 8.8–18.4 ms |
| changed persist (touch 1 open proposal) | 2.3 ms | ~19–21 ms |

Cost is **linear in total proposals ever created**, while the working set of
most operations is the *open* proposals only. A long-lived DAO accumulates
closed proposals forever, so every CLI/MCP command that persists gets slower
every year regardless of activity.

Serialization dominates: `JSON.stringify(state, null, 2)` alone is ~80% of a
no-op persist at 500 proposals. Closed proposals are the bulk: they carry full
deliberation output (votes, agent outputs, synthesis, acceptance criteria) plus
satellite records (`outcomes`, `artefacts`, `snapshots`, `verifications`,
`controlResults`, `deliveryPlans` — all keyed by proposal id and growing with
closed proposals too).

### Constraints

- `DaoStateRepositoryPort.get(): DAOState` returns the full state and every
  consumer (health score, `list --unrated`, `rate`, metrics, CLI, MCP tools)
  reads **and mutates** closed-proposal data through it in memory. The in-memory
  API must not change.
- `state.json` is a documented, human-readable format; concurrent writers are
  arbitrated by the `stateRevision` optimistic gate (issue #153) plus
  proposal-id containment checks, all under `withFileLock`.
- Crash safety relies on atomic tmp+rename writes; ordering between writes in
  the locked critical section is free to choose.
- `decisions/*.json` holds only a 7-field summary per closed proposal — **not**
  the full proposal. The full proposal exists only in `state.json` today.
- Repair paths (`repairCounters`, `repairState`) must keep guaranteeing
  collision-free ids (issue #157) across restores and hand edits.

## Decision

Partition persistence **on disk only**: closed proposals and their satellite
records move to a new `.dao/archive.json`; `state.json` keeps everything else.
The in-memory state stays a single merged `DAOState`; partitioning happens
exclusively inside `FileDaoStateRepository` at write time and merging at open
time.

### Disk layout after the change

```
.dao/
  state.json      # open + deliberating proposals, agents, config, auditLog,
                  # counters, stateRevision, and the satellite maps FILTERED
                  # to non-archived proposal ids
  archive.json    # { proposals: [...closed full objects...],
                  #   outcomes, artefacts, snapshots, verifications,
                  #   controlResults, deliveryPlans }  -- archived ids only
  decisions/      # unchanged derived summaries (regenerable)
  config.json     # unchanged
```

### Open / merge

1. Parse `state.json` (existing `repairState`).
2. Read `archive.json` (missing → empty; corrupt → same error wrapping as
   `state.json`).
3. Merge into one in-memory `DAOState`:
   - archive proposals **shadow** same-id open proposals from `state.json`
     (the archive copy is always the newer closed version — see crash ordering);
   - satellite map entries from the archive override same-key entries from
     `state.json`.
4. Run `repairCounters` **after** the merge, so `nextProposalId` /
   `nextAuditId` account for archived ids (issue #157 invariant: a restored
   old `state.json` next to an existing archive can never reuse ids).

### Persist flow (locked critical section)

1. `checkNoConcurrentModification()` — unchanged; it now compares the *open*
   partition. Soundness unchanged: any concurrent writer must have bumped
   `stateRevision` in `state.json`, which the gate detects.
2. Bump `stateRevision` (unchanged).
3. **Write `archive.json` first** (atomic, `writeIfChanged`-guarded), then
   `state.json`, then `decisions/`.
   - Crash between (3) and (4): archive contains the newer closed copy while
     `state.json` still lists the proposal as open; the shadow-on-merge rule
     resolves it deterministically on next open. The reverse order would
     **lose** the proposal entirely, hence the ordering is normative.
4. No-op detection (`hasPendingWrites`): skip lock and I/O only when
   - the serialized `state.json` partition is byte-identical to the cache, **and**
   - the archive partition is clean (see mutation contract below).

### The mutation contract (the crux)

With closed data out of `state.json`, a mutation of archived data (e.g.
`rate` on an executed proposal updating `state.outcomes[id]`) no longer
changes the `state.json` partition. Today's "state.json byte-identical ⇒
nothing changed" trust no longer covers the archive. Three mechanisms make it
sound:

1. **Structural signature (automatic).** A cheap O(closed) probe — closed
   proposal count + max archived id + satellite map key counts — is compared
   per persist. Closures, and first-time creation of a satellite entry, are
   caught with zero API change (~0.05 ms at 2000 closed).
2. **`markArchivedDirty()` on the repository port (explicit).** Use cases that
   mutate *values inside* archived satellite records (re-rating an existing
   outcome, replacing an artefact) must call it before `persist()`. Known call
   sites today (all in `application/` + `delivery/`): `rate-proposal`,
   `control-proposal`, `execute-proposal`, `delivery/execution.ts`, plus
   status-transition paths. The port documents the contract.
3. **No-op inherits today's trust model.** A no-op persist (both checks clean)
   writes nothing — identical semantics to today, where a byte-identical
   `state.json` also skips everything.

A forgotten `markArchivedDirty()` degrades to "in-place value edit lost on a
no-op persist" only when the edit does not change any structural signature —
the test plan pins the known call sites so regressions surface in CI.

### Migration

- **No migration step.** A legacy `state.json` with inline closed proposals
  loads fine (everything merges); the first *writing* persist partitions it.
  Read-only commands never write, preserving today's property.
- **Version skew:** an old binary reading a partitioned repo sees only open
  proposals in `state.json` (closed data invisible; `decisions/` summaries
  still readable). Acceptable: the monorepo ships core and hosts in lockstep.
- **`archive.json` is authoritative** for closed data. Deleting it loses
  closed proposals (today: deleting `state.json` loses everything). Documented
  in `docs/USAGE.md`.
- The legacy `persistence.ts` compat path (`loadState`/`saveState`) stays
  monolithic and archive-unaware; it is migration-only and must not be used on
  partitioned repos (noted in its doc comment).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Compact JSON on disk | −28% serialize cost, but breaks the documented human-readable format; asymptotics unchanged. |
| Dirty tracking via Proxy on `get()` | Transparent, but hides I/O semantics, adds overhead on every property access, and fights the plain-object style all consumers rely on. |
| Full `markDirty` API (no structural fallback) | Most explicit, but touches every mutation site including closures; the hybrid keeps closure flows untouched. |
| Per-proposal archive files `.dao/archive/NNN.json` | Append-friendly, but doubles the file count already present in `decisions/` and complicates `repairCounters` scans (readdir) for no measured need. |
| Archive `auditLog` too (Phase 2, below) | Required for a *true* O(open) no-op, but a different integrity model (append-only trail); split into its own phase. |

## Phases

### Phase 1 (this ADR): proposals + satellite maps

No-op persist cost drops from O(total proposals) to **O(open + auditLog)**.
With audit entries ~300 B vs closed proposals ~700 B–1.5 KB each, a
closed-heavy regime (2000 closed, 20 open) improves roughly 5–15× depending on
deliberation fat.

### Phase 2 (follow-up ADR): `auditLog` → `.dao/audit.jsonl`

Append-only JSONL with a persisted `auditWatermark` in `state.json`; load
dedupes by entry id; optional compaction command. After Phase 2, no-op persist
is truly O(open). Not started until Phase 1 is shipped and measured.

## Test plan (all in `packages/core/tests/file-repository.*` + `persistence.test.ts`)

| Test | Asserts |
|---|---|
| round-trip with archive | close → persist → reopen → full proposal (votes, outputs, synthesis) restored from `archive.json` |
| shadow rule | hand-crafted `state.json` listing id 5 open + archive containing id 5 closed → merged state has only the closed version |
| crash ordering | write archive then simulate crash before `state.json` → reopen yields the closed version, no data loss |
| rate after archival | rate an executed (archived) proposal → persist → reopen → outcome present; no-op persist afterwards keeps it |
| structural signature | first outcome/artefact entry for an archived id (without `markArchivedDirty`) still lands on disk |
| counters | old `state.json` (low `nextProposalId`) + archive with high ids → `repairCounters` pushes past archived max, no collision on create |
| concurrency | stale copy of a partitioned repo refuses to persist (`stateRevision` gate) |
| decisions unchanged | `decisions/index.json` + per-id files still match closed set after partitioning |
| legacy migration | inline-closed `state.json` → first persist writes `archive.json`, `state.json` shrinks; second persist is a no-op |
| architecture contract | no new forbidden imports; repository logic stays in the adapter |

## Benchmarks & success criteria

`persistence.benchmark.ts` gains a closed-heavy repository (2000 closed + 20
open) with cases: no-op persist, touch-open persist, closure persist, reload.

| Metric (2000 closed + 20 open, fat proposals) | Before | Target |
|---|---|---|
| no-op persist | 8.8–18.4 ms | **≤ 1.5 ms** |
| changed persist (touch 1 open) | ~19–21 ms | **≤ 4 ms** |
| reload | ~0.6 ms (500 lean) | ≈ archive parse cost, no regression vs today at equal size |
| `bun run bench:compare` | — | no regression on any existing suite |

**Measured result (implementation of this ADR, 2026-09-18):** no-op
**0.30 ms**, touch-open **1.57 ms** — both targets met (66× and ~13×).
`state.json` shrinks from ~11 MB to 2 KB in the 2000-closed regime; all
665 core tests and the existing benchmark suites pass without regression.

## Risks

- **Silent-loss regression** if a future mutation site skips
  `markArchivedDirty()` and dodges the structural signature. Mitigation: test
  plan pins every known site; the port doc comment states the contract.
- **`archive.json` corruption** loses closed detail (summaries survive in
  `decisions/`). Mitigation: atomic writes, same error wrapping as
  `state.json`; backup-on-repair pattern reused from issue #167.6.
- **Complexity in the hottest correctness path.** Mitigation: partition/merge
  implemented as pure functions over `(DAOState, ArchivePartition)` so the
  logic is unit-testable without disk.

## Open questions

1. Ship Phase 2 (audit JSONL) in the same release cycle, or measure Phase 1
   first? (Recommendation: measure first.)
2. Should `archive.json` include a schema version field from day one?
   (Recommendation: yes — one integer, costs nothing.)
