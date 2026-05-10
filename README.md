# Swarm DAO

> **Unified AI Agent Governance** — One DAO core, multiple host adapters.

Swarm DAO unifies the governance systems from [pi-swarm-dao](https://github.com/guyghost/pi-swarm-dao) and [opencode-dao](https://github.com/guyghost/opencode-dao) into a single, extensible architecture.

## Quick Start

```bash
# Clone
git clone https://github.com/guyghost/swarm-dao.git
cd swarm-dao

# Install dependencies
bun install
bun add typebox

# Link workspace package (Bun workspaces may need manual symlink)
mkdir -p node_modules/@swarm-dao
ln -s ../../packages/core node_modules/@swarm-dao/core

# Register Pi extension
mkdir -p .pi/extensions
ln -s ../../packages/pi-adapter/src/index.ts .pi/extensions/swarm-dao.ts

# Start Pi — the extension is auto-discovered
pi
```

Inside Pi:
```
> dao_setup          # Initialize with 7 default agents
> dao_propose        # Create a proposal
> dao_deliberate     # Run swarm deliberation
> dao_check          # Quality gates
> dao_execute        # Execute approved proposal
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Hosts                                                      │
│  ┌─────────┐  ┌─────────────┐  ┌──────────┐  ┌──────────┐  │
│  │   Pi    │  │  OpenCode   │  │   CLI    │  │ Future…  │  │
│  └────┬────┘  └──────┬──────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │             │         │
│  ┌────┴──────────────┴──────────────┴─────────────┴─────┐   │
│  │              Host Adapter Interface                  │   │
│  │   spawnAgent · spawnAgents · log · exec · readFile  │   │
│  └─────────────────────────┬────────────────────────────┘   │
│                            │                                 │
│  ┌─────────────────────────┴────────────────────────────┐   │
│  │                   Swarm DAO Core                     │   │
│  │  ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌────────┐ │   │
│  │  │Governance│ │Intelligence│ │ Delivery │ │Control │ │   │
│  │  │  (L1)    │ │   (L2)     │ │  (L3)    │ │ (L4)   │ │   │
│  │  └──────────┘ └────────────┘ └──────────┘ └────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
│  ┌─────────────────────────┴────────────────────────────┐   │
│  │              Persistence (.dao/ local files)         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@swarm-dao/core` | Pure business logic (~3000 lines) |
| `@swarm-dao/pi-adapter` | Bridge to Pi coding agent |
| `@swarm-dao/opencode-adapter` | Bridge to OpenCode |
| `@swarm-dao/cli` | Standalone CLI (`swarm-dao`) |

## 4-Layer Governance

| Layer | Purpose | Key Concepts |
|-------|---------|--------------|
| **L1 Governance** | Decide what enters the roadmap | Proposals, voting, quorum, state machine, amendments |
| **L2 Intelligence** | Produce analysis and recommendations | 7 specialized agents, parallel deliberation, synthesis |
| **L3 Delivery** | Convert decisions into execution | Plans, tasks, execution, verification, artefacts |
| **L4 Control** | Reduce risk before publication | Quality gates, audit trail, checklists |

## The 7 Default Agents

| Agent | Weight | Role |
|-------|--------|------|
| Product Strategist | 3 | Vision, objectives, hypotheses |
| Research Agent | 2 | Market, competition, user signals |
| Solution Architect | 3 | Technical options, tradeoffs |
| Critic / Risk Agent | 3 | Risk scoring, objections, guardrails |
| Prioritization Agent | 2 | Impact/cost/risk scoring, roadmap fit |
| Spec Writer | 1 | PRD, user stories, acceptance criteria |
| Delivery Agent | 1 | Implementation plan, tasks, CI/CD |

## Proposal Lifecycle

```
open ──► deliberating ──► approved ──► controlled ──► executed
                       ╲              ╲              ╲
                     rejected       rejected        failed
```

## CLI Usage

```bash
# Initialize DAO storage
swarm-dao init

# Setup with default agents
swarm-dao setup

# Create proposal
swarm-dao propose --title "Add dark mode" --type product-feature \
  --description "Implement dark theme for the app"

# List proposals
swarm-dao list
swarm-dao list --status open
swarm-dao list --type security-change

# Show proposal details
swarm-dao show 1

# Cast a vote
swarm-dao vote 1 --position for --reasoning "Low risk, high impact" --weight 3

# View audit trail
swarm-dao audit
swarm-dao audit --proposal 1

# View DAO status
swarm-dao status

# View configuration
swarm-dao config
```

## Pi Usage

The Pi extension is auto-discovered from `.pi/extensions/` or `~/.pi/agent/extensions/`.

```bash
# Initialize
> dao_setup

# Create proposal
> dao_propose title="Add dark mode" type="product-feature" \
    description="Implement dark theme"

# Deliberate (automatic swarm dispatch)
> dao_deliberate proposalId=1

# Check quality gates
> dao_check proposalId=1

# Execute
> dao_execute proposalId=1

# View audit
> dao_audit proposalId=1
```

## OpenCode Usage

```bash
# Initialize
> dao_setup

# Create proposal
> dao_propose title="Add dark mode" type="product-feature" \
    description="Implement dark theme"

# Get dispatch plan (manual sub-agent spawning)
> dao_deliberate proposalId=1

# Record outputs after collecting from sub-agents
> dao_record_outputs proposalId=1 outputs=[...]

# Control gates
> dao_control proposalId=1

# Execute
> dao_execute proposalId=1
```

## Configuration

Per-project config in `.dao/config.json`:

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

Modes:
- `opt-in` *(default)* : Tools available but never auto-invoked
- `suggest` : Nudges assistant to consider DAO proposal for trigger keywords
- `enforce` : Blocks edits on critical paths without approved proposal

## Artefacts

Auto-generated for every approved proposal:

| Artefact | Description |
|----------|-------------|
| Decision Brief | Executive summary with key votes |
| ADR | Architecture Decision Record |
| Risk Report | Risks, permissions, guardrails |
| PRD Lite | User stories, scope, metrics |
| Implementation Plan | Phases, tasks, critical path |
| Test Plan | Unit, integration, E2E tests |
| Release Packet | Changelog, checklist, rollback |

## GitHub Integration

```bash
# Configure
> dao_config_github token="ghp_..." owner="myorg" repo="myrepo" enabled=true

# Create branch
> dao_github_create_branch proposalId=1

# Open PR
> dao_github_open_pr proposalId=1 headBranch="dao/1-add-dark-mode"
```

## Persistence

DAO state stored in `.dao/`:
- `state.json` — monolithic state snapshot
- `proposals/NNN.json` — per-proposal sidecar files
- `decisions/NNN.json` — compact decision summaries
- `config.json` — per-project configuration

## Adding a New Host

See [docs/EXTENSION-GUIDE.md](docs/EXTENSION-GUIDE.md).

Quick overview:

```typescript
import type { HostAdapter } from "@swarm-dao/core";

const myAdapter: HostAdapter = {
  hostId: "my-host",
  spawnAgent: async ({ agent, proposal, systemPrompt }) => { /* ... */ },
  spawnAgents: async ({ agents, proposal, maxConcurrent }) => { /* ... */ },
  log: async ({ level, message }) => { /* ... */ },
  getWorkingDirectory: () => process.cwd(),
  readFile: async (path) => { /* ... */ },
  writeFile: async (path, content) => { /* ... */ },
  exec: async (command, options) => { /* ... */ },
  hasCapability: (cap) => true,
};
```

## Testing

```bash
# Run all tests
bun test

# Run specific package tests
bun test packages/core/tests
bun test packages/cli/tests
```

## CI/CD

GitHub Actions workflow included (`.github/workflows/ci.yml`):
- Type checking
- Test execution
- Build verification

## Documentation

- [ADR-001: Unified Architecture](docs/ADR-001-unified-architecture.md)
- [Extension Guide](docs/EXTENSION-GUIDE.md)
- [Usage Guide](docs/USAGE.md)
- [Agent Prompts](docs/AGENT-PROMPTS.md)

## License

MIT
