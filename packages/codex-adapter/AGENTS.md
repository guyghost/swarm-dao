# AGENTS.md — Swarm DAO governance

This repository is governed by **Swarm DAO**, a multi-agent governance layer.
Proposals are deliberated by a swarm of agents, validated by quality-control
gates, then executed and tracked.

## Workflow (always follow this order)

1. `dao_setup` — create the default 7 product agents (once per repo).
2. `dao_propose` — open a proposal (`title`, `type`, `description`).
3. `dao_deliberate proposalId=N` — returns a dispatch plan naming the agents and
   the model each should use.
4. Spawn one sub-agent per dispatch-plan entry (Codex subagents / `codex exec`).
5. `dao_record_outputs proposalId=N outputs=[...]` — feed each sub-agent's
   `agentId` + `content` back into the DAO.
6. `dao_control proposalId=N` — run the quality gates.
7. `dao_execute proposalId=N` — apply the approved change.
8. `dao_ship proposalId=N` — cascade and finalize dependencies.

## Rules

- Treat `dao_*` tool results as the source of truth for DAO state.
- Never hand-edit files under `.swarm-dao/` — always use the DAO tools.
- If a gate fails in `dao_control`, fix the root cause; do not force-skip.
- Run `dao_dry_run` before `dao_execute` for risky changes.
- Use `dao_rollback` to revert a misbehaving executed proposal.
- Rate outcomes with `dao_rate` to keep the governance health score accurate.

## Discovery

- `dao_help`, `dao_list`, `dao_agents`, `dao_dashboard`, `dao_audit`
