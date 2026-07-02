---
description: Scaffold a Swarm DAO proposal
allowed-tools: mcp__swarm-dao__dao_propose
---

Scaffold a Swarm DAO proposal. Ask the user (or infer from the conversation)
for these fields, then call the `dao_propose` MCP tool:

- `title` — short proposal title
- `type` — one of the DAO proposal types (ask `dao_help` if unsure)
- `description` — what the proposal does
- optional: `acceptanceCriteria` (string[]), `successMetrics` (string[]),
  `rollbackConditions` (string[]), `affectedPaths` (string[])

After creating the proposal, remind the user to run `/dao-deliberate` next.
