---
"@guyghost/swarm-dao-core": minor
---

Remove the redundant per-proposal sidecar files

Proposals were persisted twice: once in `state.json` (the authoritative state)
and again as standalone `.dao/proposals/NNN.json` "sidecar" files. The sidecar
layer is removed so `state.json` is the single source of truth for proposals.

`saveState()` no longer writes or reconciles per-proposal files, and
`loadState()` no longer merges sidecars back into state. On the first load
after upgrading, any existing sidecars whose proposal id is missing from
`state.json` are imported, then the now-dead `proposals/` directory is removed.

The removed functions `loadProposalsFromDisk`, `saveProposal`, `getProposalPath`,
and `getProposalsDir` were internal helpers not re-exported from the package
barrel, so this is storage-internal with no public API change. The
`security_fix.test.ts` suite (which tested `loadProposalsFromDisk` log safety)
has been removed with it.
