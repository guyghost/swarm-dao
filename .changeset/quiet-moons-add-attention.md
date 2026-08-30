---
"@guyghost/swarm-dao-core": minor
---

Add a read-only attention queue: `collectAttention` / `classifyAttention` / `formatAttention` in observability, an `FsAttentionStore` filesystem adapter, an `attention` CLI-only registry command, and the `swarm-dao attention [--source ...]` CLI command. The sweep aggregates pending human decisions across Graph Engineering runs (`awaitingApproval`, `retrying`), Improvement Loop cycles (`adjusting`, `retrying`), and Product Loop runs (`review`) from the persisted evidence snapshots. It never sends events, never mutates machine state, and skips unreadable runs.
