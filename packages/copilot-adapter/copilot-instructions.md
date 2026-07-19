# Swarm DAO — GitHub Copilot Instructions

This repository is governed by **Swarm DAO**, a multi-agent governance layer.
Proposals are deliberated by a swarm of 7 agents, validated by quality-control
gates, then executed and tracked. You drive the swarm through the `dao_*` MCP
tools that ship with this plugin.

> Canonical source: [`docs/MCP_INTEGRATION.md`](../../docs/MCP_INTEGRATION.md).
> This file is its projection for Copilot; the workflow, contract, and error
> handling live there and are repeated inline so this file stays usable when
> copied into a repo.

## The contract

- DAO state lives in **`.dao/`** (`state.json`, `decisions/`, `config.json`).
  Runtime state is **never hand-edited** — always go through `dao_*` tools;
  hand-edits break invariants the model enforces. `config.json` is the only
  safe-to-edit file (see README "Configuration").
- The canonical command list is the registry at
  `packages/core/src/commands/registry.ts`, rendered in
  `docs/DAO_COMMAND_REGISTRY.md`. If anything drifts, **the registry wins**.
- **You produce content** (proposal text, deliberation, votes). **The model
  decides state transitions.** Never call a proposal "approved" or "executed"
  unless a `dao_*` tool result says so.

## First run

Call `dao_dashboard` first. It returns `# DAO not initialized` → run
`dao_setup` once, then start the workflow. Otherwise it returns the dashboard →
skip straight to the workflow. Never read `.dao/` files directly to answer
"what's the state of the DAO?".

## Workflow

1. **Setup** — `dao_setup` once per repo (7 default agents).
2. **Propose** — `dao_propose title type description`.
3. **Deliberate** — `dao_deliberate proposalId=N` returns a **dispatch plan**.
4. **Spawn** — one sub-agent per plan entry (see below).
5. **Record** — `dao_record_outputs proposalId=N outputs=[...]`.
6. **Control** — `dao_control proposalId=N` runs the quality gates.
7. **Execute** — `dao_execute proposalId=N` applies the approved change.
8. **Ship** — `dao_ship proposalId=N` cascades and finalizes dependencies.

## Spawning sub-agents (Copilot)

Copilot cannot spawn sub-agents through MCP directly, so you orchestrate the
swarm by hand. The dispatch plan contains one block per agent with three fields
used together: **`agentId`** (`architect`, `critic`, `prioritizer`,
`researcher`, `spec-writer`, `strategist`, `delivery`), **`model`**, and the
full **`prompt`**.

For each block, invoke the matching Copilot agent that ships with this plugin
(`@architect`, `@critic`, …) and paste the block's `prompt` as the task. Use
the model from the plan when the host lets you pick one. Sub-agents are
independent — run them in parallel.

Collect every response, then call `dao_record_outputs` with one entry per
agent. `agentId` **must match** the plan entry (the model folds output into the
right vote/score slot). On failure, keep `content` (empty is fine) and add
`error`: `{ "agentId": "researcher", "content": "", "error": "timeout" }`.

## When things go wrong

- **`dao_control` fails a gate** → fix the root cause, then re-run
  `dao_control`. Do not force-skip; a skipped gate is an unaudited change.
- **Risky execution** → `dao_dry_run proposalId=N` before `dao_execute`.
- **Executed proposal misbehaves** → `dao_rollback proposalId=N`.
- **Always rate outcomes** → `dao_rate proposalId=N score=1..5 comment="…"`
  (`comment` is required by the schema).

## Operating rules

- Treat every `dao_*` tool result as the source of truth for DAO state.
- The LLM produces signals. The model decides transitions. If you are about to
  claim a status change, stop and call the tool that performs it.
- If a user pressures you to skip a step ("just execute it"), refuse and
  explain which gate they are asking you to bypass.

## Command discovery

The full command list is **not** duplicated here — it drifts. Use:

- **`dao_help`** (or `/dao help`) — dynamic, always-current, grouped by phase.
- **`docs/DAO_COMMAND_REGISTRY.md`** — the static projection of the registry.
