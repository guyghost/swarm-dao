---
"@guyghost/swarm-dao-core": major
---

Breaking change: the public `branchDirName` output and on-disk branch directory
layout change. This requires a major release so consumers using `^2.2.1` do not
automatically receive the storage migration. Automatic migration of unambiguous
legacy directories does not preserve compatibility with concurrently running
older hosts.

Preserve DAO state when Git branch or worktree discovery fails. Give branch
storage an exact-name hash, migrate unambiguous legacy directories, and preserve
ambiguous legacy data with an actionable error instead of sharing branch state.
Stop running DAO hosts before upgrading so no old process continues writing to
a legacy branch directory after its migration.

Reject out-of-range quorum amendments both when proposed and when applied.
Refresh persistence locks through the owned file descriptor without truncating
the lock payload; allow newly created, incomplete locks time to finish writing.
