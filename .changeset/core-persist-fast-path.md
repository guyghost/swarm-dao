---
"@guyghost/swarm-dao-core": patch
---

persistence: skip lock, concurrency check and I/O when persist() has nothing to write, and skip the JSON.parse of state.json when the on-disk bytes match what this instance last read or wrote. Removes the redundant per-persist mkdir in the lock path. Cuts the per-persist cost added by the inter-process lock (9eee0bf), especially for unchanged-state persists.
