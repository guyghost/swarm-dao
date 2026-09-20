---
"@guyghost/swarm-dao-core": minor
---

Archive closed proposals out of `state.json` (ADR-004).

Closed proposals and their satellite records (`outcomes`, `artefacts`,
`snapshots`, `verifications`, `controlResults`, `deliveryPlans`) move to
`.dao/archive.json`; `state.json` keeps only open/deliberating proposals.
The in-memory `DAOState` stays a single merged view — `get()` is
unchanged for every consumer. On open, the archive is merged back
(archived ids shadow stale live copies); on persist, the archive is
written before `state.json` (crash ordering), and only when its
structural signature changed, `markArchivedDirty()` was called, or it is
not yet on disk.

`DaoStateRepositoryPort` gains `markArchivedDirty()`: use cases mutating
values behind the archive's structural signature (re-rating an existing
outcome, re-executing plan/snapshot writes) must call it. Structural
changes (closures, status transitions, new satellite entries) are
detected automatically. Legacy monolithic `state.json` files migrate on
the first writing persist; `repairCounters` now accounts for archived
ids so restored backups cannot collide.

Measured (2000 closed + 20 open proposals): no-op persist 17.5 ms →
**0.30 ms** (66×), touch-open persist → **1.57 ms**; `state.json`
11 MB → 2 KB.
