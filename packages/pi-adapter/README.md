# @guyghost/swarm-dao-pi-adapter

> Bridge [Swarm DAO](https://github.com/guyghost/swarm-dao) governance to the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

This package exports a Pi extension that registers tools, commands, and event hooks so any Pi user can run multi-agent governance directly inside their coding session.

## Installation

### As a dependency

```bash
# Add the adapter and its peer dependencies
bun add @guyghost/swarm-dao-pi-adapter typebox
bun add --peer @earendil-works/pi-coding-agent @earendil-works/pi-ai
```

### Register with Pi

Create or edit `.pi/extensions/swarm-dao.ts` in your project:

```ts
import swarmDaoExtension from "@guyghost/swarm-dao-pi-adapter";

export default swarmDaoExtension;
```

Alternatively, point Pi at the built file via `package.json`:

```jsonc
{
  "pi": {
    "extensions": ["./node_modules/@guyghost/swarm-dao-pi-adapter/dist/index.js"]
  }
}
```

## Usage

### Quick Start

Once Pi starts, the extension automatically:

1. **Restores state** on `session_start` — loads `.dao/` from your project root
2. **Injects context** on `before_agent_start` — appends DAO status to the system prompt

Inside Pi, use any of the registered tools or the `/dao` command:

```
> dao_setup                           # Initialize with 7 default agents
> dao_propose title="Add dark mode"   # Create a proposal
  type="product-feature"
  description="Implement dark mode toggle"
> dao_deliberate proposalId=1         # Run swarm deliberation
> dao_check proposalId=1              # Quality control gates
> dao_ship proposalId=1               # Ship controlled proposal (check deps)
```

### Tools

All tools are registered as MCP tools and can be invoked by the LLM or manually.

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `dao_setup` | Initialize the DAO with 7 default agents | `useDefaults?: boolean` |
| `dao_propose` | Create a new governance proposal | `title`, `type`, `description`, `context?`, `problemStatement?`, `acceptanceCriteria?`, `successMetrics?`, `rollbackConditions?`, `affectedPaths?` |
| `dao_deliberate` | Run swarm deliberation on a proposal | `proposalId` |
| `dao_check` | Run quality control gates on an approved proposal | `proposalId` |
| `dao_plan` | View the delivery plan for a proposal | `proposalId` |
| `dao_execute` | Execute a controlled/approved proposal | `proposalId` |
| `dao_ship` | Ship a controlled proposal, with optional dependency cascade | `proposalId`, `cascade?`, `force?` |
| `dao_audit` | View the audit trail (optionally filtered by proposal) | `proposalId?` |
| `dao_artefacts` | View auto-generated artefacts (ADR, risk report, PRD, etc.) | `proposalId` |
| `dao_rate` | Rate a proposal outcome post-execution (1–5 stars) | `proposalId`, `score`, `comment` |
| `dao_dashboard` | View outcome tracking dashboard and health score | *(none)* |
| `dao_dry_run` | Preview execution without applying changes | `proposalId` |
| `dao_rollback` | Revert a proposal to its pre-execution snapshot | `proposalId` |
| `dao_roundtable` | Ask every agent to suggest a proposal idea | *(none)* |
| `dao_update_proposal` | Update structured fields on an open proposal | `proposalId`, `problemStatement?`, `acceptanceCriteria?`, `successMetrics?`, `rollbackConditions?` |

### Commands

| Command | Description |
|---------|-------------|
| `/dao` | Show the DAO dashboard (`/dao` or `/dao status`) |
| `/dao help` | Show command help and the recommended next tools |
| `/dao setup` | Initialize DAO directly from the slash command |

### Event Hooks

| Event | When | What it does |
|-------|------|--------------|
| `session_start` | Pi session begins | Initializes `.dao/` storage, loads or creates state |
| `before_agent_start` | Before each LLM turn | Injects DAO status into the system prompt so the agent is context-aware |

## Proposal Types

Proposals are categorized and routed through type-specific councils and quorum rules:

| Type | Label | Default Quorum |
|------|-------|----------------|
| `product-feature` | ✨ Product Feature | 60% |
| `security-change` | 🔒 Security Change | 75% |
| `technical-change` | ⚙️ Technical Change | 60% |
| `release-change` | 📦 Release Change | 50% |
| `governance-change` | 📜 Governance Change | 70% |

## Architecture

The adapter bridges Pi to the Swarm DAO core's **4-layer governance model**:

```
┌─────────────────────────────────────────────────────────┐
│  Pi Coding Agent                                        │
│  ┌─────────────────────────────────────────────────┐    │
│  │  swarm-dao-pi-adapter (this package)            │    │
│  │  • Registers tools, commands, event hooks       │    │
│  │  • Implements HostAdapter for Pi's agent runner │    │
│  └──────────────────────┬──────────────────────────┘    │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────┐
│  @guyghost/swarm-dao-core                               │
│                                                         │
│  L1 Governance ── L2 Intelligence ── L3 Delivery        │
│  Proposals          Deliberation       Execution         │
│  Voting             Scoring            Plans             │
│  Lifecycle          Synthesis          Dry-run           │
│                      Round Table       Rollback          │
│                                                         │
│  L4 Control ─────────────────────────────────────────── │
│  Quality Gates · Audit Trail · Checklists               │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────┐
│  Persistence (.dao/)                                    │
│  state.json · audit.json · scores.json · artefacts/     │
└─────────────────────────────────────────────────────────┘
```

### Host Adapter

The adapter implements the `HostAdapter` interface from `@guyghost/swarm-dao-core`:

| Method | Pi Implementation |
|--------|-------------------|
| `spawnAgent` | Produces structured agent output (analysis, vote, score inputs) for deliberation and roundtable flows |
| `spawnAgents` | Delegates to `spawnAgent` sequentially |
| `log` | Writes to `console.log` with structured format |
| `getWorkingDirectory` | Returns `process.cwd()` |
| `readFile` | Uses `node:fs/promises` |
| `writeFile` | Uses `node:fs/promises` |
| `exec` | Uses `node:child_process` |
| `hasCapability` | Reports `read_file`, `write_file`, `exec`, `log` |

> **Note on `spawnAgent`:** The adapter now returns structured fallback outputs when host-level subprocess spawning is unavailable, so deliberation can still reach quorum and complete end-to-end.

## Configuration

The DAO uses sensible defaults. To customize, modify `.dao/state.json` after initialization:

| Setting | Default | Description |
|---------|---------|-------------|
| `quorumPercent` | 60 | Minimum participation % |
| `approvalThreshold` | 55 | Minimum approval % |
| `riskThreshold` | 7 | Risk score threshold (1–10) |
| `maxConcurrent` | 4 | Max agents running in parallel |

## Development

```bash
# Install dependencies
bun install

# Build
cd packages/pi-adapter && bun run build

# Test
bun test

# Type-check only
bun run typecheck
```

## License

MIT — see [LICENSE](../../LICENSE).
