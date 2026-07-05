# CLAUDE.md — Swarm DAO governance

This repository is governed by **Swarm DAO**, a multi-agent governance layer.
Proposals are deliberated by a swarm of agents, validated by quality-control
gates, then executed and tracked.

## Workflow (always follow this order)

1. `dao_setup` — create the default 7 product agents (once per repo).
2. `dao_propose` — open a proposal (`title`, `type`, `description`).
3. `dao_deliberate proposalId=N` — returns a dispatch plan naming the agents and
   the model each should use.
4. Spawn one sub-agent per dispatch-plan entry (use the `Task` tool / subagents).
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

## Slash commands

This package ships a full `/dao:*` namespace with native tab completion.
Copy `commands/` into `.claude/commands/` to enable them. The colon-namespaced
commands are auto-generated as flat files `commands/dao:<id>.md` (colons in
filenames, not subdirectories).

### `/dao:*` namespace (generated from the registry)

Every lifecycle, discovery, governance, and GitHub command is available as
`/dao:<id>`:

- `/dao:setup`, `/dao:propose`, `/dao:deliberate`, `/dao:record-outputs`,
  `/dao:control`, `/dao:execute`, `/dao:ship`, `/dao:rollback`
- `/dao:help`, `/dao:status`, `/dao:list`, `/dao:agents`, `/dao:plan`,
  `/dao:artefacts`, `/dao:audit`, `/dao:dry-run`, `/dao:roundtable`
- `/dao:rate`, `/dao:update-proposal`, `/dao:propose-amendment`
- `/dao:github-config`, `/dao:github-branch`, `/dao:github-pr`

Run `bun run generate-commands` to regenerate the namespace from the registry.

## Discovery

- `dao_help`, `dao_list`, `dao_agents`, `dao_dashboard`, `dao_audit`
