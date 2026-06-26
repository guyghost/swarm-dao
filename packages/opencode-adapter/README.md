# @guyghost/swarm-dao-opencode-adapter

> Swarm DAO governance adapter for [OpenCode](https://opencode.ai) — bring multi-agent deliberation, quality gates, and structured decision-making to your coding workflow.

## Overview

This adapter bridges the [Swarm DAO](https://github.com/guyghost/swarm-dao) core governance engine to the OpenCode platform via the `@opencode-ai/plugin` API. It registers 16 DAO tools that OpenCode agents can invoke directly, enabling structured proposal creation, multi-agent deliberation, quality control gates, and execution tracking — all from within the OpenCode environment.

Swarm DAO implements a **4-layer governance model**:

| Layer | Purpose | Tools |
|-------|---------|-------|
| **L1 Governance** | Decide what enters the roadmap | `dao_setup`, `dao_propose`, `dao_propose_amendment` |
| **L2 Intelligence** | Produce analysis and recommendations | `dao_record_outputs`, `dao_roundtable` |
| **L3 Delivery** | Convert decisions into execution | `dao_execute`, `dao_plan`, `dao_artefacts`, `dao_dry_run`, `dao_rollback` |
| **L4 Control** | Reduce risk before publication | `dao_control`, `dao_audit`, `dao_dashboard` |
| **Utility** | Inspect DAO state | `dao_help`, `dao_list`, `dao_agents` |

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) v1.14.19 or later
- [Bun](https://bun.sh) v1.3.0 or later

### Install the package

```bash
bun add @guyghost/swarm-dao-opencode-adapter
```

### Register in your OpenCode config

Add the plugin to your `opencode.json` (or `opencode.jsonc`):

```jsonc
{
  "plugin": [
    ["@guyghost/swarm-dao-opencode-adapter", {}]
  ]
}
```

Or register it without options:

```json
{
  "plugin": [
    "@guyghost/swarm-dao-opencode-adapter"
  ]
}
```

The plugin initializes automatically when OpenCode starts. DAO state is persisted in a `.dao/` directory within your project root.

## Usage

### 1. Initialize the DAO

```
> dao_setup
> dao_help
```

Creates the DAO with 7 default product agents:

| Agent | Weight | Role |
|-------|--------|------|
| Product Strategist | 3 | Vision, objectives, hypotheses |
| Research Agent | 2 | Market, competition, user signals |
| Solution Architect | 3 | Technical options, tradeoffs |
| Critic / Risk Agent | 3 | Risk scoring, objections, guardrails |
| Prioritization Agent | 2 | Impact/cost/risk scoring, roadmap fit |
| Spec Writer | 1 | PRD, user stories, acceptance criteria |
| Delivery Agent | 1 | Implementation plan, tasks, CI/CD |

### 2. Create a Proposal

```
> dao_propose title="Add dark mode" type="product-feature" description="Implement dark theme for the application"
```

**Supported proposal types:**

| Type | Description |
|------|-------------|
| `product-feature` | New user-facing feature |
| `technical-change` | Refactoring, architecture, tooling |
| `security-change` | Security-related modifications |
| `governance-change` | DAO configuration or agent changes |
| `bug-fix` | Bug fix with impact analysis |
| `experiment` | Time-boxed experiment with success criteria |

Optional fields for richer proposals:
- `context` — Additional context for reviewers
- `problemStatement` — What problem does this solve?
- `acceptanceCriteria` — List of acceptance criteria
- `successMetrics` — How to measure success
- `rollbackConditions` — When to rollback
- `affectedPaths` — File paths authorized for editing

### 3. Deliberate (Record Agent Outputs)

OpenCode doesn't support automatic agent spawning. Use `dao_record_outputs` to submit outputs collected manually from sub-agents:

```
> dao_record_outputs proposalId=1 outputs='[
  { "agentId": "product-strategist", "content": "High impact...", "durationMs": 1200, "error": null },
  { "agentId": "critic", "content": "VOTE: FOR — Low risk...", "durationMs": 800, "error": null }
]'
```

Agents can cast votes by including `VOTE: FOR|AGAINST` in their output text. The system tallies votes, calculates composite scores, and generates a synthesis automatically.

### 4. Run Quality Control

```
> dao_control proposalId=1
```

Runs quality gates: risk assessment, scope validation, and readiness checks. Proposals must pass all gates before execution.

### 5. Preview (Dry Run)

```
> dao_dry_run proposalId=1
```

Previews the execution plan without applying changes.

### 6. Execute

```
> dao_execute proposalId=1
```

Executes an approved proposal. Requires the proposal to have passed through `approved` or `controlled` status.

### 7. Review and Monitor

```
> dao_list              # List all proposals
> dao_agents            # List registered agents
> dao_plan proposalId=1 # View delivery plan
> dao_artefacts proposalId=1  # View auto-generated artefacts
> dao_dashboard         # Full governance dashboard
> dao_audit             # Full audit trail
> dao_audit proposalId=1      # Proposal-specific audit trail
```

### 8. Round Table

```
> dao_roundtable
```

Asks every agent to suggest a proposal idea. Because OpenCode doesn't support automatic agent spawning, the round table uses the host adapter's dispatch mechanism. Any successfully parsed suggestions are automatically promoted to proposals.

### 9. Rollback

```
> dao_rollback proposalId=1
```

Reverts a proposal execution to its pre-execution snapshot (if available).

### 10. Amendments

```
> dao_propose_amendment title="Increase critic weight" description="Give the critic more influence" amendmentType="agent-update" agentId="critic" agentChanges='{"weight": 5}'
```

Supported amendment types:

| Type | Required Fields |
|------|----------------|
| `agent-update` | `agentId`, `agentChanges` (JSON) |
| `agent-add` | `newAgentId`, `newAgentName`, `newAgentRole`, `newAgentWeight` |
| `agent-remove` | `agentId` |
| `config-update` | `configChanges` (JSON) |
| `quorum-update` | `quorumChanges` (JSON) |
| `gate-update` | `addGates`, `removeGates` |

## Configuration

Per-project configuration in `.dao/config.json`:

```json
{
  "mode": "suggest",
  "criticalPaths": [
    "src/auth/**",
    "src/payment/**",
    ".env*"
  ],
  "agentOverrides": {
    "researcher": { "enabled": false },
    "critic": { "weight": 5 }
  }
}
```

**Modes:**
- `opt-in` *(default)* — Tools available but never auto-invoked
- `suggest` — Nudges assistant to consider DAO proposal for trigger keywords
- `enforce` — Blocks edits on critical paths without approved proposal

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenCode Host                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              @opencode-ai/plugin API                   │  │
│  │   PluginInput → Plugin → Hooks { tool, ... }          │  │
│  └───────────────────────────┬───────────────────────────┘  │
│                              │                               │
│  ┌───────────────────────────┴───────────────────────────┐  │
│  │        OpenCode Adapter (this package)                 │  │
│  │   OpenCodeDAO plugin • 16 tools • HostAdapter impl     │  │
│  └───────────────────────────┬───────────────────────────┘  │
│                              │                               │
│  ┌───────────────────────────┴───────────────────────────┐  │
│  │             @guyghost/swarm-dao-core                   │  │
│  │  ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌────────┐ │  │
│  │  │Governance│ │Intelligence│ │ Delivery │ │Control │ │  │
│  │  │  (L1)    │ │   (L2)     │ │  (L3)    │ │ (L4)   │ │  │
│  │  └──────────┘ └────────────┘ └──────────┘ └────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                              │                               │
│  ┌───────────────────────────┴───────────────────────────┐  │
│  │              Persistence (.dao/ local files)           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Tool Reference

| Tool | Description |
|------|-------------|
| `dao_setup` | Initialize the DAO with 7 default product agents |
| `dao_help` | Show onboarding and recommended workflow |
| `dao_propose` | Create a new governance proposal |
| `dao_record_outputs` | Record sub-agent outputs and finalize deliberation |
| `dao_control` | Run quality control gates on an approved proposal |
| `dao_execute` | Execute an approved or controlled proposal |
| `dao_list` | List all DAO proposals |
| `dao_agents` | List all registered DAO agents |
| `dao_plan` | View the delivery plan for a proposal |
| `dao_artefacts` | View auto-generated artefacts (ADR, PRD, test plan, etc.) |
| `dao_dry_run` | Preview execution without applying changes |
| `dao_rollback` | Revert a proposal execution to pre-execution state |
| `dao_dashboard` | View the governance outcome dashboard with health score |
| `dao_roundtable` | Ask every agent to suggest a proposal idea |
| `dao_audit` | View the full audit trail or per-proposal trail |
| `dao_propose_amendment` | Propose a change to DAO agents, config, or gates |

## Proposal Lifecycle

```
open ──► deliberating ──► approved ──► controlled ──► executed
                       ╲              ╲              ╲
                     rejected       rejected        failed
```

## Limitations

- **No automatic agent spawning** — OpenCode doesn't provide an API for spawning sub-agents. Use `dao_record_outputs` to manually submit outputs from sub-agent conversations.
- **Single-process** — All deliberation happens within the OpenCode plugin process. For large-scale parallel agent work, consider the CLI.

## Related Packages

| Package | Description |
|---------|-------------|
| [`@guyghost/swarm-dao-core`](https://github.com/guyghost/swarm-dao/tree/main/packages/core) | Pure business logic (~3000 lines) |
| [`@guyghost/swarm-dao-opencode-adapter`](https://github.com/guyghost/swarm-dao/tree/main/packages/opencode-adapter) | Bridge to OpenCode (this package) |
| [`@guyghost/swarm-dao-cli`](https://github.com/guyghost/swarm-dao/tree/main/packages/cli) | Standalone CLI (`swarm-dao`) |

## License

MIT
