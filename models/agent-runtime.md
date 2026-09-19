# Agent Runtime Model (harness + model resolution)

- **Status**: Draft — awaiting exact-hash human approval
- **Scope**: Per-agent LLM harness (pi, claude, codex, copilot, opencode, …) and model resolution for the Swarm DAO
- **Executable source of truth**: `packages/core/src/intelligence/runtime.ts` (pure functions)
- **Change control**: Any change to decision tables D1–D4, failure modes E1–E5, or invariants I1–I6 requires a new model revision and human approval of the new hash

## 1. Purpose

The DAO dispatches work to AI agents. Each agent runs on a **harness** (the CLI/runtime that
hosts the agent: `pi`, `claude`, `codex`, `copilot`, `opencode`, …) using a **model**
(e.g. `z.ai/GLM-5.1`, `gpt-5.4`, `claude-opus-4-6`).

Today the harness is a single global value (`.dao/config.json` → `herdr.kind`) and the model
follows a fixed inheritance chain (pinned in configuration or inherited from the main model —
ADR-006). This model makes both **per-agent configurable** while
keeping every decision deterministic, validated, and free of any LLM influence.

## 2. Why a contract, not a state machine

Harness/model resolution is a **synchronous pure function**: given
`(agent config, project runtime config, host context)` it returns either a resolved runtime
or a typed failure. There is no asynchronous state, no concurrency, no journal, and no
terminal-state immutability concern. Per `models/CONTRACT.md`, stateless decision logic is
modeled as a deterministic decision contract (tables D1–D4) with typed terminal failures,
not as an XState machine. The LLM/AI boundary is preserved exactly as in stateful workflows:
**resolution inputs come only from configuration and code; agent output can never select a
harness or a model** (invariant I2).

## 3. Inputs (configuration surface)

### 3.1 `.dao/config.json` (ProjectConfig additions)

```jsonc
{
  "runtime": {
    "defaultHarness": "claude",        // optional, string, harness id (§4.1)
    "harnessModelFlag": {              // optional, per-harness override of the frozen flag table
      "grok": "--model"
    }
  },
  "tmux": {
    "command": "claude -p \"$PROMPT\"",           // existing, global default
    "agentCommands": {                            // optional, per-agent override
      "critic": "codex exec --model gpt-5.4 \"$PROMPT\""
    }
  },
  "agentOverrides": {
    "critic":     { "harness": "codex",   "model": "gpt-5.4" },
    "researcher": { "harness": "pi",      "model": "z.ai/GLM-5.1" }
  }
}
```

### 3.2 Agent definition (`DAOAgent` additions)

- `harness?: string` — optional harness id (same syntax domain as `model`).
- `model?: string` — existing field, unchanged semantics.

### 3.3 Host context (computed by code, never by configuration alone)

- `hostDefaultHarness`: the harness the current host natively spawns:
  - host `pi` → `"pi"`
  - host `herdr` → `config.herdr.kind` (back-compat)
  - host `mcp` (claude/codex/copilot/opencode sessions) → the host id itself; spawn is manual
  - host `tmux` → none (the configured command *is* the harness)

## 4. Decision tables

### 4.1 Harness id syntax (validated everywhere a harness id appears)

- Regex: `^[a-z][a-z0-9_-]{0,31}$` (same charset family as herdr `SAFE_KIND`).

### 4.2 Model id syntax

- Regex: `^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,127}$`
- Rationale: must admit `z.ai/GLM-5.1`, `gpt-5.4`, `claude-opus-4-6`, `o4-mini`;
  rejects leading `-` (option injection), whitespace (multi-token split), and every shell
  metacharacter. Identifiers travel as **single ARGV tokens**; they are never interpolated
  into shell strings (I5).

### 4.3 D1 — Harness resolution (first match wins)

| # | Source | Value |
|---|--------|-------|
| 1 | `agent.harness` | explicit per-agent override |
| 2 | `runtime.defaultHarness` | project-wide default |
| 3 | `hostDefaultHarness` | host-native default (pi → `pi`, herdr → `herdr.kind`, mcp host → host id, tmux → none) |
| 4 | none of the above | failure **E2** |

Precedence note: `runtime.defaultHarness` **overrides** `herdr.kind` (explicit new global wins
over legacy field; `herdr.kind` remains effective when `runtime.defaultHarness` is absent).

### 4.4 D2 — Model resolution

Implemented in `packages/core/src/intelligence/model.ts` (ADR-006 — no DAO-wide
default model). First match wins:

| # | Source | Nature |
|---|--------|--------|
| 1 | `agent.model` (≠ `"inherit"`) | user spec (agent frontmatter) |
| 2 | `delegationProfile[archetype].model` | user spec (delegated child archetype) |
| 3 | parent agent's resolved model | inheritance (delegation) |
| 4 | parent session model | the main model |
| 5 | host main model (`hostDefaultModel`) | inheritance |
| 6 | none of the above | sentinel `"default"` |

A model is either pinned explicitly in configuration or inherited from the
main model; there is no `DAOConfig.defaultModel` layer. The value `"default"`
means "host decides" and disables explicit flag emission (D3 row 3).

### 4.5 D3 — Model flag emission (herdr path and rendered instructions)

Frozen flag table (`HARNESS_MODEL_FLAGS`, core):

| Harness | Flag |
|---------|------|
| pi | `--model` |
| claude | `--model` |
| codex | `--model` |
| copilot | `--model` |
| opencode | `--model` |

| # | Condition | Result |
|---|-----------|--------|
| 1 | harness in table (or overridden via `runtime.harnessModelFlag[harness]`) | emit `[flag, model]` after `--` |
| 2 | model requested, harness **not** in table, no config override | failure **E4** |
| 3 | model resolved to `"default"` | emit nothing (host default) |

Config override values must match `^--[a-z][a-z0-9-]*$`; violation → **E5**.

## 5. Failure modes (typed, terminal for the affected dispatch only)

| Code | Condition | Remediation hint |
|------|-----------|------------------|
| E1 | harness id violates §4.1 | fix `harness` in agent definition or `runtime.defaultHarness` |
| E2 | no harness resolvable (D1 exhausted) | set `runtime.defaultHarness` or `agent.harness` |
| E3 | model id violates §4.2 | fix `model` in the agent definition or delegation profile |
| E4 | model requested for harness with unknown flag | set `runtime.harnessModelFlag[harness]` or drop per-agent model |
| E5 | `harnessModelFlag` value violates flag syntax | use form `--flag-name` |

Failure semantics: a resolution failure produces an **error AgentOutput for that agent only**;
the deliberation tally treats it as a missing output (existing quorum rules). It never throws
across the dispatch loop and never mutates proposal state.

## 6. Per-host effect mapping

| Host | harness | model | Mechanism |
|------|---------|-------|-----------|
| pi | must equal `"pi"` else **E-host** (below) | yes | existing `pi … --model <model>` ARGV |
| herdr | any §4.1 id | yes, via D3 | `herdr agent start <name> --kind <harness> … -- [agentArgs…] [flag, model]` |
| tmux | implicit in command | operator-authored | per-agent command: `tmux.agentCommands[agentId]` → fallback global `tmux.command`; `$PROMPT` file mechanism unchanged |
| mcp (claude/codex/copilot/opencode) | rendered as advisory text | rendered (existing `model=` line) | dispatch plan tells the human which harness+model to run; no auto-spawn |

E-host (pi): when D1 resolves a harness ≠ `"pi"` on host pi, the spawn fails with a typed
error message pointing at `agent.harness` / `runtime.defaultHarness`. Same rule pattern for
any future native-single-harness host.

## 7. Invariants

- **I1 (Totality)**: resolution is pure and total — it always returns
  `(resolved runtime) | (typed failure)`, never throws, never blocks on I/O.
- **I2 (AI boundary)**: no LLM output, agent output, proposal text, or free text ever
  selects harness, model, or flag. Inputs are configuration and code only.
- **I3 (No state mutation)**: resolution never mutates proposal state, session state, or
  `.dao/` artifacts. It is read-only over config.
- **I4 (Determinism)**: same inputs → same outputs. No clock, randomness, or network.
- **I5 (Injection safety)**: harness/model/flag tokens are validated (§4.1, §4.2, D3) and
  passed as ARGV elements; they never appear inside a shell string. tmux commands are
  operator-owned config, unchanged in trust level.
- **I6 (Explicit over implicit)**: precedence is fixed (D1); silent fallback that would
  change the effective harness or silently drop an explicit model is forbidden (E4).

## 8. Test obligations (Verify phase)

1. D1 table: each precedence row + exhaustion → E2.
2. §4.1/§4.2 validators: accept-lists and reject-lists (leading `-`, metachars, whitespace,
   null byte, overlong).
3. D3: flag table hits, config override, miss → E4, `"default"` → no emission, E5.
4. Host mapping: pi (harness≠pi error), herdr ARGV construction (kind + trailing flag/model,
   agentArgs ordering), tmux per-agent command lookup + fallback, dispatch-plan rendering for
   MCP hosts.
5. Config loading: `runtime`, `tmux.agentCommands`, `agentOverrides…harness` parse + reject
   invalid values at load time where feasible.
6. Invariant spot-checks: resolution called twice → identical result; failure output does not
   throw outside the per-agent scope.
