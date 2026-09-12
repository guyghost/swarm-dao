---
"@guyghost/swarm-dao-core": patch
---

Fix FileDaoStateRepository persistence: atomic tmp+rename writes and serialized intra-process queue. Prevents partial state.json on crash, matching legacy writeAtomic behavior.
