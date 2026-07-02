---
description: Control, execute, and ship a Swarm DAO proposal
allowed-tools: mcp__swarm-dao__dao_control, mcp__swarm-dao__dao_execute, mcp__swarm-dao__dao_ship, mcp__swarm-dao__dao_rate
---

Ship a Swarm DAO proposal through the final gates.

1. Read the proposal id from `$ARGUMENTS` (or ask the user).
2. Call `dao_control proposalId=N`. If any gate fails, stop and report.
3. Call `dao_execute proposalId=N`.
4. Call `dao_ship proposalId=N` (cascade if there are unexecuted dependencies).
5. Ask the user to rate the outcome, then call
   `dao_rate proposalId=N score=<1-5> comment="..."`.
6. Summarize what shipped and any follow-up proposals.
