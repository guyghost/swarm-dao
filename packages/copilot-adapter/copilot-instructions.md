# Swarm DAO — GitHub Copilot Instructions

You are operating inside a **Swarm DAO**-governed repository. Swarm DAO is a
multi-agent governance layer: proposals are deliberated by a swarm of agents,
validated by quality-control gates, then executed and tracked.

## The DAO workflow

Always follow this order. Do not skip steps.

1. **Setup** — `dao_setup` once per repo to create the default 7 product agents.
2. **Propose** — `dao_propose` with a `title`, `type`, and `description`.
3. **Deliberate** — `dao_deliberate proposalId=N` returns a dispatch plan that
   names the agents to run and the model each should use.
4. **Dispatch** — spawn one sub-agent per entry in the dispatch plan (Copilot
   cannot spawn agents through MCP, so run them yourself as separate tasks).
5. **Record** — `dao_record_outputs proposalId=N outputs=[...]` with each
   sub-agent's `agentId` + `content`.
6. **Control** — `dao_control proposalId=N` runs the quality gates.
7. **Execute** — `dao_execute proposalId=N` applies the approved change.
8. **Ship** — `dao_ship proposalId=N` cascades and finalizes dependencies.

## Operating rules

- Treat every `dao_*` tool result as the source of truth for DAO state.
- Never edit `.swarm-dao/` files directly — always go through the DAO tools.
- If `dao_control` fails a gate, fix the root cause, do not force-skip.
- Prefer `dao_dry_run` before `dao_execute` for risky changes.
- Use `dao_rollback` if an executed proposal misbehaves.
- Rate outcomes with `dao_rate` so the governance health score stays accurate.

## Useful discovery tools

- `dao_help` — current workflow and tool list
- `dao_list` — proposal overview
- `dao_agents` — configured agents
- `dao_dashboard` — governance health summary
- `dao_audit` — audit trail
