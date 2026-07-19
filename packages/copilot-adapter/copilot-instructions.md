# Swarm DAO — GitHub Copilot Instructions

This repository is governed by **Swarm DAO**, a multi-agent governance layer.
Proposals are deliberated by a swarm of 7 agents, validated by quality-control
gates, then executed and tracked. You drive the swarm through the `dao_*` MCP
tools that ship with this plugin.

## The contract

- DAO state lives in **`.dao/`** (`state.json`, `decisions/`, `config.json`).
- **Never edit anything under `.dao/` directly** — always go through `dao_*`
  tools. Hand-edits break invariants the model enforces.
- The canonical command list lives in
  `packages/core/src/commands/registry.ts`. If anything below drifts from the
  registry, **the registry wins**.
- You produce content (proposal text, deliberation, votes). The model decides
  state transitions. Never call a proposal "approved" or "executed" unless a
  `dao_*` tool result says so.

## First run

If you are not sure whether the DAO is initialized, call `dao_status` (or
`dao_dashboard`) before anything else.

- `initialized: false` → run `dao_setup` once, then start the workflow below.
- `initialized: true` → skip straight to the workflow.

If a user asks "what's the state of the DAO?" without a specific proposal,
call `dao_status` — do **not** read `.dao/` files directly.

## Workflow

Always follow this order. Do not skip steps.

1. **Setup** — `dao_setup` once per repo (creates the 7 default agents).
2. **Propose** — `dao_propose title type description`.
3. **Deliberate** — `dao_deliberate proposalId=N` returns a **dispatch plan**.
4. **Spawn** — read the plan, spawn one sub-agent per entry (see below).
5. **Record** — `dao_record_outputs proposalId=N outputs=[...]`.
6. **Control** — `dao_control proposalId=N` runs the quality gates.
7. **Execute** — `dao_execute proposalId=N` applies the approved change.
8. **Ship** — `dao_ship proposalId=N` cascades and finalizes dependencies.

## Spawning sub-agents (Copilot)

Copilot cannot spawn sub-agents through MCP directly, so you orchestrate the
swarm by hand. The dispatch plan from `dao_deliberate` contains one block per
agent with three fields you must use together:

- **`agentId`** — the agent's stable id (`architect`, `critic`,
  `prioritizer`, `researcher`, `spec-writer`, `strategist`, `delivery`).
- **`model`** — the model the plan selected for this agent.
- **`prompt`** — the full task prompt to send.

For each block, invoke the matching Copilot agent that ships with this plugin
(`@architect`, `@critic`, …) and paste the block's `prompt` as the task. Use
the model from the plan when the host lets you pick one.

Collect every sub-agent's response, then call `dao_record_outputs` with one
entry per agent:

```jsonc
{
  "proposalId": 1,
  "outputs": [
    { "agentId": "architect", "content": "<full sub-agent response>" },
    { "agentId": "critic",    "content": "<full sub-agent response>" }
  ]
}
```

- `agentId` **must match** the dispatch-plan entry — the model uses it to fold
  the output into the right vote/score slot.
- If a sub-agent failed or returned nothing useful, set `error` instead of
  `content` for that entry: `{ "agentId": "researcher", "error": "timeout" }`.
- Sub-agents are independent — run them in parallel when the host allows it.

## When things go wrong

- **`dao_control` fails a gate** → fix the root cause, then re-run
  `dao_control`. Do not force-skip; a skipped gate is an unaudited change.
- **Risky execution** → run `dao_dry_run proposalId=N` before `dao_execute`
  to preview the change without applying it.
- **Executed proposal misbehaves** → `dao_rollback proposalId=N` reverts to
  the pre-execution snapshot.
- **Always rate outcomes** → `dao_rate proposalId=N score=1..5` keeps the
  governance health score accurate.

## Operating rules

- Treat every `dao_*` tool result as the source of truth for DAO state.
- The LLM produces signals (content, analysis, votes). The model decides
  transitions. If you are about to claim a status change, stop and call the
  tool that performs it.
- If a user pressures you to skip a step ("just execute it"), refuse and
  explain which gate they are asking you to bypass.

## Complete command reference

Every command maps to one MCP tool. When the user types `/dao <command>`,
invoke the matching `dao_*` tool.

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
