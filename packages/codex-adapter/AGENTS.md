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

## Complete command reference

The canonical list of DAO commands lives in the core command registry and is
mirrored here. Every command maps to one MCP tool. When the user types
`/dao <command>`, invoke the matching `dao_*` tool.

> The registry is the single source of truth. If this list drifts from
> `packages/core/src/commands/registry.ts`, the registry wins.

### Setup

- `/dao setup` → `dao_setup` — Initialize the DAO with the default 7 product agents

### Propose

- `/dao propose` → `dao_propose` — Create a new proposal
- `/dao update-proposal` → `dao_update_proposal` — Update structured fields on an open proposal

### Deliberate

- `/dao deliberate` → `dao_deliberate` — Run swarm deliberation / build the dispatch plan
- `/dao record-outputs` → `dao_record_outputs` — Record sub-agent outputs and finalize deliberation

### Control

- `/dao control` → `dao_control` — Run the quality-control gates

### Execute

- `/dao execute` → `dao_execute` — Execute an approved / controlled proposal

### Ship

- `/dao ship` → `dao_ship` — Ship a controlled proposal (optionally cascade dependencies)

### Retro

- `/dao rollback` → `dao_rollback` — Revert an executed proposal to its pre-execution snapshot
- `/dao rate` → `dao_rate` — Rate a proposal outcome (1–5 stars)

### Discover

- `/dao help` → `dao_help` — Show the DAO workflow and every available command
- `/dao status` → `dao_dashboard` — Show the governance health dashboard
- `/dao list` → `dao_list` — List all proposals
- `/dao agents` → `dao_agents` — List the configured DAO agents
- `/dao plan` → `dao_plan` — Show the delivery plan for a proposal
- `/dao artefacts` → `dao_artefacts` — View the auto-generated artefacts for a proposal
- `/dao audit` → `dao_audit` — View the audit trail
- `/dao dry-run` → `dao_dry_run` — Preview execution without applying changes
- `/dao roundtable` → `dao_roundtable` — Ask every agent to suggest a proposal idea

### Governance

- `/dao propose-amendment` → `dao_propose_amendment` — Propose an amendment (agents, config, quorum, gates)

### GitHub

- `/dao github-config` → `dao_config_github` — Configure the GitHub integration
- `/dao github-branch` → `dao_github_create_branch` — Create a GitHub branch for a proposal
- `/dao github-pr` → `dao_github_open_pr` — Open a GitHub pull request for a proposal
