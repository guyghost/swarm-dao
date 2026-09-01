---
"@guyghost/swarm-dao-core": minor
---

`swarm-dao attention` (and every host reusing `FsAttentionStore`) now also sweeps the CLI-default project roots (`.dao/graph-runs`, `.dao/improvement-cycles`, `.dao/product-loops`) alongside the documented `evidence/` roots, so foreign projects that keep all state under `.dao/` finally surface their pending human gates. A runId present in both roots resolves to the documented root's snapshot. Suggested graph/product resolution commands now use the `swarm-dao` CLI form, which works in any project.
