---
"@guyghost/swarm-dao-core": patch
---

core: stop losing proposals the archive signature cannot see.

Two related defects could destroy proposal data on a write:

1. A closed proposal that only `state.json` carries (the layout older CLIs
   wrote) was removed from the live partition by `partitionState`, but the
   archive-changed check compared `id:status` signatures — which already
   included it after loading. The archive was therefore not rewritten and the
   proposal ended up in neither file. The loader now marks the archive dirty
   when it takes over a closed proposal that `archive.json` does not hold yet.

2. The archive signature ignores field-level changes, so any use case that
   mutates a closed proposal must call `markArchivedDirty()`. The dry-run use
   case did not, which silently dropped `dryRunAt`/`dryRunCanProceed`: the
   mandatory-dry-run gate reported a completed dry-run that was never persisted.

`isArchivedStatus` also moves to `domain/proposal-status.ts` (re-exported from
its previous home) so application code can consult the archived/live rule
without importing infrastructure.
