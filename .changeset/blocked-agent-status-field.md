---
"@guyghost/swarm-dao-herdr-adapter": patch
"@guyghost/swarm-dao-improvement": patch
---

Read herdr's real `agent_status` lifecycle field when classifying settled agent states. herdr exposes `result.agent.agent_status`; the executors only read `agent.status`/`agent.state`, so the blocked-agent guard (approval/question UI) could never fire — a blocked worker was harvested as a confusing transcript error instead of the accurate "agent is blocked — it never produced a signal/vote" (issue #138). Applies to both the improvement-loop worker executor and the herdr deliberation host adapter; test fixtures now mirror the real herdr JSON contract.
