---
"@guyghost/swarm-dao-core": patch
---

FileDaoStateRepository: inter-process file lock (state.lock with stale cleanup) and fail-fast concurrent-modification detection. persist() no longer silently overwrites proposals persisted by another writer — it throws and asks to reopen and retry.
