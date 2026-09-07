---
"@guyghost/swarm-dao-herdr-adapter": patch
"@guyghost/swarm-dao-improvement": patch
---

Fix the `agent start` readiness race against herdr (`agent_pane_busy`). `herdr workspace create` returns before the fresh pane's shell has reached its interactive prompt, and `herdr agent start` classifies such a pane as busy instead of waiting — slower shell init under herd load (several agents working at once) made the failure intermittent and burned whole executor attempts (fresh workspace per retry, same race each time). `herdr agent start` is now retried on the SAME pane (1 s apart, via the new exported `startAgentUntilReady` helper) until the readiness budget (`startTimeoutMs`) is spent, in both the deliberation host adapter and the improvement-loop worker executor; any other herdr error code still fails immediately.
