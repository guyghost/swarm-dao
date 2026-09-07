---
"@guyghost/swarm-dao-herdr-adapter": patch
"@guyghost/swarm-dao-improvement": patch
---

Recover from `agent_prompt_stalled` instead of abandoning live workers. herdr's `agent prompt --wait` requires an observed state change within a hardcoded 5 s window; a fresh agent in a heavy repo under load can exceed it while the prompt was accepted and is being processed, and the executors treated the stall as a dead attempt — closing the workspace and retrying from scratch (issue #137, reproduced live: the agent answered while herdr reported `agent_prompt_stalled`). On stall, the new shared `promptAgentUntilSettled` helper grace-polls `agent get` (20 s default): if the agent came alive it waits for settle with `agent wait`; only a submission that stayed idle through the grace period is re-prompted, exactly once (a naive re-prompt risks double submission into a working agent).
