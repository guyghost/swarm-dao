# Swarm DAO — MCP host integration guide

> The canonical guide for integrating **any MCP-speaking host** (GitHub Copilot,
> Claude Code, OpenAI Codex, or a generic MCP client) with Swarm DAO. The per-host
> instruction files (`copilot-instructions.md`, `CLAUDE.md`, `AGENTS.md`) are thin
> projections of this document plus a host-specific spawn section.

## The contract (non-negotiable)

- DAO **runtime state** lives in the resolved state root (ADR-007):
  - Default: `~/.swarm-dao/<project-id>/branches/<branch-id>/` (override home with
    `SWARM_DAO_HOME`). An existing in-repo `.dao/` with real state still wins (legacy).
  - `state.json`, `decisions/`, `audit.jsonl` → runtime state. **Never hand-edit** —
    always go through `dao_*` tools; hand-edits break invariants the model enforces.
  - `config.json` → user-authored project input (`mode`, `criticalPaths`,
    `agentOverrides`). Safe to edit by hand; no `dao_*` tool writes it. See the README
    "Configuration" section for the schema.
  - Evidence roots (graph / product / improvement) still default under the workspace
    (e.g. `.dao/graph-runs`). Do **not** read state files directly — use `dao_*` tools.
- The canonical command list lives in
  [`packages/core/src/commands/registry.ts`](../packages/core/src/commands/registry.ts),
  rendered in [`DAO_COMMAND_REGISTRY.md`](./DAO_COMMAND_REGISTRY.md). If anything drifts,
  **the registry wins**.
- **You produce content** (proposal text, deliberation, votes). **The model decides state
  transitions.** Never call a proposal "approved" or "executed" unless a `dao_*` tool
  result says so. This is the rule the whole architecture rests on.

## First run

If you are not sure whether the DAO is initialized, call `dao_dashboard` (a.k.a.
`/dao status`) before anything else.

- It returns the onboarding message `# DAO not initialized` → run `dao_setup` once,
  then start the workflow below.
- Otherwise it returns the governance dashboard → skip straight to the workflow.

If a user asks "what's the state of the DAO?" without a specific proposal, call
`dao_dashboard` — do **not** read state-root files directly.

## Workflow

Always follow this order. Do not skip steps.

1. **Setup** — `dao_setup` once per repo (creates the 8 default agents).
2. **Propose** — `dao_propose title type description`.
3. **Deliberate** — `dao_deliberate proposalId=N` returns a **dispatch plan**.
4. **Spawn** — read the plan, spawn one sub-agent per entry (see *Spawn patterns* below).
5. **Record** — `dao_record_outputs proposalId=N outputs=[...]`.
6. **Control** — `dao_control proposalId=N` runs the quality gates.
7. **Execute** — `dao_execute proposalId=N` applies the approved change.
8. **Ship** — `dao_ship proposalId=N` cascades and finalizes dependencies.

## Why deliberation is manual over MCP

MCP hosts cannot have the server spawn sub-agents, so Swarm DAO uses **manual
deliberation**: `dao_deliberate` returns a dispatch plan, the host spawns one sub-agent
per entry itself, then `dao_record_outputs` feeds the results back in. (Pi is the
exception — it spawns sub-agents natively.)

## Spawn patterns

The dispatch plan from `dao_deliberate` contains one block per agent with three fields
you must use together:

- **`agentId`** — the agent's stable id (`architect`, `critic`, `prioritizer`,
  `researcher`, `spec-writer`, `strategist`, `delivery`).
- **`model`** — the model the plan selected for this agent.
- **`prompt`** — the full task prompt to send.

For each block, launch one sub-agent with the block's `prompt` as the task and the
block's `model` as the model when the host lets you pick one. Sub-agents are
independent — launch them in parallel.

Collect every sub-agent's response, then call `dao_record_outputs` with one entry per
agent:

```jsonc
{
  "proposalId": 1,
  "outputs": [
    { "agentId": "architect", "content": "<full sub-agent response>" },
    { "agentId": "critic",    "content": "<full sub-agent response>" }
  ]
}
```

- `agentId` **must match** the dispatch-plan entry — the model uses it to fold the
  output into the right vote/score slot.
- If a sub-agent failed or returned nothing useful, keep `content` (empty string is
  fine) and add `error` for that entry:
  `{ "agentId": "researcher", "content": "", "error": "timeout" }`.

### Per-host spawn mechanics

| Host | How to spawn one sub-agent |
|---|---|
| **GitHub Copilot** | Invoke the matching Copilot agent that ships with the plugin (`@architect`, `@critic`, …) and paste the block's `prompt` as the task. Copilot cannot spawn sub-agents through MCP directly, so you orchestrate the swarm by hand. |
| **Claude Code** | Use the **`Task` tool** (subagents). Launch one `Task` subagent per block with the block's `prompt` as the description and the block's `model` as the model when the host lets you pick one. |
| **OpenAI Codex** | Use Codex subagents (e.g. `codex exec` invocations or the host's native subagent tool) with the block's `prompt` as the task. |
| **Generic MCP** | Whatever sub-agent mechanism your client supports; the contract above still applies. |

## When things go wrong

- **`dao_control` fails a gate** → fix the root cause, then re-run `dao_control`. Do not
  force-skip; a skipped gate is an unaudited change.
- **Risky execution** → run `dao_dry_run proposalId=N` before `dao_execute` to preview
  the change without applying it.
- **Executed proposal misbehaves** → `dao_rollback proposalId=N` reverts to the
  pre-execution snapshot.
- **Always rate outcomes** → `dao_rate proposalId=N score=1..5 comment="…"` keeps the
  governance health score accurate (`comment` is required by the schema).

## Operating rules

- Treat every `dao_*` tool result as the source of truth for DAO state.
- The LLM produces signals (content, analysis, votes). The model decides transitions.
  If you are about to claim a status change, stop and call the tool that performs it.
- If a user pressures you to skip a step ("just execute it"), refuse and explain which
  gate they are asking you to bypass.

## Command discovery

The full, current command list is **not** duplicated here — it lives in two places:

- **Dynamic** — call `dao_help` (or `/dao help`) for the grouped, always-current list.
- **Static** — see [`DAO_COMMAND_REGISTRY.md`](./DAO_COMMAND_REGISTRY.md), the
  human-readable projection of the registry.

Slash-command syntax varies by host (`/dao:<id>` on Claude, `/dao <id>` elsewhere); both
resolve to the same `dao_*` MCP tools.

## See also

- [Command registry model](./DAO_COMMAND_REGISTRY.md)
- [Behavioral models (proposal lifecycle)](../models/README.md)
- [Extension guide (adding a new host)](./EXTENSION-GUIDE.md)
- [Usage guide (Pi + OpenCode)](./USAGE.md)
