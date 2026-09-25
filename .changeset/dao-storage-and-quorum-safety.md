---
"@guyghost/swarm-dao-core": patch
---

Preserve DAO state when Git branch or worktree discovery fails. Give branch
storage an exact-name hash, migrate unambiguous legacy directories, and preserve
ambiguous legacy data with an actionable error instead of sharing branch state.
Stop running DAO hosts before upgrading so no old process continues writing to
a legacy branch directory after its migration.

Reject out-of-range quorum amendments both when proposed and when applied.
Refresh persistence locks through the owned file descriptor without truncating
the lock payload; allow newly created, incomplete locks time to finish writing.
