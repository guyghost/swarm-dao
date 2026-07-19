# CLAUDE.md — Swarm DAO governance

This repository is governed by **Swarm DAO**, a multi-agent governance layer.
Proposals are deliberated by a swarm of 7 agents, validated by quality-control
gates, then executed and tracked. You drive the swarm through the `dao_*` MCP
tools and the `/dao:*` slash commands that ship with this adapter.

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

If you are not sure whether the DAO is initialized, call `dao_dashboard`
before anything else.

- It returns the onboarding message `# DAO not initialized` → run
  `dao_setup` once, then start the workflow below.
- Otherwise it returns the governance dashboard → skip straight to the
  workflow.

If a user asks "what's the state of the DAO?" without a specific proposal,
call `dao_dashboard` — do **not** read `.dao/` files directly.

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

## Spawning sub-agents (Claude Code)

Use the **`Task` tool** (subagents). The dispatch plan from `dao_deliberate`
contains one block per agent with three fields you must use together:

- **`agentId`** — the agent's stable id (`architect`, `critic`,
  `prioritizer`, `researcher`, `spec-writer`, `strategist`, `delivery`).
- **`model`** — the model the plan selected for this agent.
- **`prompt`** — the full task prompt to send.

For each block, launch one `Task` subagent with the block's `prompt` as the
task description and the block's `model` as the model when the host lets you
pick one. Sub-agents are independent — launch them in parallel.

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
- If a sub-agent failed or returned nothing useful, keep `content` (empty
  string is fine) and add `error` for that entry:
  `{ "agentId": "researcher", "content": "", "error": "timeout" }`.

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

## Slash commands

This adapter ships a full `/dao:*` namespace with native tab completion. Copy
`commands/` into `.claude/commands/` to enable them. The colon-namespaced
files (`commands/dao:<id>.md`) are auto-generated from the registry — run
`bun run generate-commands` to regenerate.

### `/dao:*` namespace (generated from the registry)

Every lifecycle, discovery, governance, and GitHub command is available as
`/dao:<id>`:

- `/dao:setup`, `/dao:propose`, `/dao:deliberate`, `/dao:record-outputs`,
  `/dao:control`, `/dao:execute`, `/dao:ship`, `/dao:rollback`
- `/dao:help`, `/dao:status`, `/dao:list`, `/dao:agents`, `/dao:plan`,
  `/dao:artefacts`, `/dao:audit`, `/dao:dry-run`, `/dao:roundtable`
- `/dao:rate`, `/dao:update-proposal`, `/dao:propose-amendment`
- `/dao:github-config`, `/dao:github-branch`, `/dao:github-pr`

The flat command catalogue lives in
[`commands/dao-commands.README.md`](commands/dao-commands.README.md); the
registry remains the single source of truth.

## Discovery

- `dao_help` — onboarding and the full workflow.
- `dao_dashboard` — governance health (proposal counts by status, audit size,
  health score).
- `dao_list`, `dao_agents`, `dao_audit` — flat listings when you need raw
  state.
