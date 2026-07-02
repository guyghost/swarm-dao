---
description: Deliberate a Swarm DAO proposal and record sub-agent outputs
allowed-tools: mcp__swarm-dao__dao_deliberate, mcp__swarm-dao__dao_record_outputs, mcp__swarm-dao__dao_control, Task
---

Deliberate a Swarm DAO proposal end-to-end.

1. Read the proposal id from `$ARGUMENTS` (or ask the user).
2. Call `dao_deliberate proposalId=N` to get the dispatch plan.
3. For each agent in the dispatch plan, spawn a sub-agent (use the `Task` tool)
   with the suggested model and the agent's brief from the dispatch plan.
4. Collect each sub-agent's output and call
   `dao_record_outputs proposalId=N outputs=[{agentId, content}, ...]`.
5. Run `dao_control proposalId=N` and report whether the gates passed.
6. Tell the user the proposal is ready for `/dao-ship` or needs fixes.
