# Swarm DAO

> **Unified AI Agent Governance** — One DAO core, multiple host adapters.

Swarm DAO unifies the governance systems from [pi-swarm-dao](https://github.com/guyghost/pi-swarm-dao) and the legacy opencode-dao project into a single, extensible architecture.

## Quick Start

```bash
# Clone
git clone https://github.com/guyghost/swarm-dao.git
cd swarm-dao

# Install dependencies
bun install

# Create local type stubs for optional host SDKs (required for typecheck/build)
bun run setup-stubs

# Link workspace package (Bun workspaces may need manual symlink)
mkdir -p node_modules/@guyghost
ln -s ../../packages/core node_modules/@guyghost/swarm-dao-core

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
> dao_ship           # Ship approved proposal (checks deps)
```

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Hosts                                                                │
│  ┌──────┐ ┌──────────┐ ┌─────────┐ ┌───────┐ ┌────────┐ ┌──────────┐ │
│  │  Pi  │ │ OpenCode │ │ Copilot │ │Claude │ │ Codex  │ │ CLI/MCP… │ │
│  └──┬───┘ └────┬─────┘ └────┬────┘ └───┬───┘ └───┬────┘ └────┬─────┘ │
│     │          │            │          │         │           │       │
│  ┌──┴──────────┴────────────┴──────────┴─────────┴───────────┴────┐  │
│  │                     Host Adapter Interface                    │  │
│  │      spawnAgent · spawnAgents · log · exec · readFile · …     │  │
│  └──────────────────────────────┬─────────────────────────────────┘  │
│                                 │                                     │
│  ┌──────────────────────────────┴─────────────────────────────────┐  │
│  │                        Swarm DAO Core                          │  │
│  │  ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌────────┐          │  │
│  │  │Governance│ │Intelligence│ │ Delivery │ │Control │          │  │
│  │  │  (L1)    │ │   (L2)     │ │  (L3)    │ │ (L4)   │          │  │
│  │  └──────────┘ └────────────┘ └──────────┘ └────────┘          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                 │                                     │
│  ┌──────────────────────────────┴─────────────────────────────────┐  │
│  │                Persistence (.dao/ local files)                │  │
│  └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

The 4 layers above are the **governance model** (what the DAO does). Internally,
`@guyghost/swarm-dao-core` is organized as a hexagonal functional core — pure
`domain`/`models` (XState workflows), `application` use cases, narrow `ports`,
instance-owned `adapters`, and `presenters` — with no ambient I/O in the
business logic. See [ADR-002](docs/ADR-002-hexagonal-core.md) and
[models/README.md](models/README.md) for that internal boundary.

Pi spawns sub-agents natively; OpenCode, Copilot, Claude Code, and Codex use
manual/MCP-based dispatch (see [Pi vs OpenCode Differences](docs/USAGE.md#pi-vs-opencode-differences)
for the pattern all non-native hosts share).

## Packages

| Package | Description |
|---------|-------------|
| `@guyghost/swarm-dao-core` | Pure business logic + shared `host-tools` handlers |
| `@guyghost/swarm-dao-mcp` | Swarm DAO as a stdio MCP server (23 tools) |
| `@guyghost/swarm-dao-copilot-adapter` | GitHub Copilot plugin (MCP + instructions) |
| `@guyghost/swarm-dao-claude-adapter` | Claude Code plugin (MCP + slash commands) |
| `@guyghost/swarm-dao-codex-adapter` | OpenAI Codex plugin (MCP + AGENTS.md) |
| `@guyghost/swarm-dao-pi-adapter` | Bridge to Pi coding agent |
| `@guyghost/swarm-dao-opencode-adapter` | Bridge to OpenCode |
| `@guyghost/swarm-dao-cli` | Standalone CLI (`swarm-dao`) |

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

# Ship (execute) a proposal
swarm-dao ship 1
swarm-dao ship 1 --cascade   # also ship unexecuted dependencies first
swarm-dao ship 1 --force     # skip dependency checks

# Configure GitHub integration
swarm-dao github-config --token <github-token> --owner myorg --repo myrepo

# Create a branch for a proposal
swarm-dao github-branch 1

# Open a pull request for a proposal
swarm-dao github-pr 1 --head-branch dao/1-add-dark-mode

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

# Ship (execute, with dependency check)
> dao_ship proposalId=1

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

## Copilot, Claude Code, and Codex Usage

These hosts don't load a native extension/plugin — they speak **MCP**. Each
has a dedicated adapter package that bundles the MCP server plus native
config and instructions:

| Host | Package | Bundles |
|------|---------|---------|
| GitHub Copilot | `@guyghost/swarm-dao-copilot-adapter` | `.vscode/mcp.json`, `copilot-instructions.md` |
| Claude Code | `@guyghost/swarm-dao-claude-adapter` | `.mcp.json`, `CLAUDE.md`, `/dao-*` slash commands |
| OpenAI Codex | `@guyghost/swarm-dao-codex-adapter` | `config.toml` snippet, `AGENTS.md` |
| Any other MCP host | `@guyghost/swarm-dao-mcp` | stdio MCP server only |

Install the adapter for your host (`npm install @guyghost/swarm-dao-<host>-adapter`)
and follow its README for the exact config file to copy. Deliberation over MCP
is always **manual**, the same pattern as OpenCode above: `dao_deliberate`
returns a dispatch plan, the host spawns the sub-agents, then
`dao_record_outputs` feeds the results back in.

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

`mode` declares intent (`opt-in` *(default)*, `suggest`, `enforce`) and
`criticalPaths` declares the paths that matter — today only `agentOverrides`
is actively applied (agents are filtered/overridden on every `dao_deliberate`
call). `mode`-based edit blocking and path-based suggestions are not wired
into any host yet; treat them as reserved schema for now.

## Delegated Facet Investigation (advanced, opt-in)

Any agent can declare `delegates` (facet + archetype) so it can hand off a
narrow sub-question to a child agent mid-deliberation. Disabled by default —
opt in per project:

```json
{
  "delegation": {
    "enabled": true,
    "maxDepth": 1,
    "maxChildrenPerParent": 3,
    "foldTimeoutMs": 30000
  }
}
```

- Children are spawned via the same `HostAdapter.spawnAgent`, one level deep
  (a child cannot itself delegate).
- The child's output is folded into the parent's content under a
  `## Delegated Facets` section — it never touches the parent's `## Vote`.
- Governed by two pure state machines (coordinator budget + per-request
  gate/fold lifecycle) in `packages/core/src/governance/delegation.machine.ts`.

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

Available via the CLI (see above) and the MCP tools (`dao_config_github`,
`dao_github_create_branch`, `dao_github_open_pr` — exposed by
`@guyghost/swarm-dao-mcp` and the Copilot/Claude/Codex adapters). **Not**
currently exposed as tools on the Pi extension or the OpenCode plugin.

```bash
# Via an MCP host (Claude, Codex, Copilot, or a generic MCP client)
> dao_config_github token="ghp_..." owner="myorg" repo="myrepo" enabled=true

# Create branch
> dao_github_create_branch proposalId=1

# Open PR
> dao_github_open_pr proposalId=1 headBranch="dao/1-add-dark-mode"
```

## Persistence

DAO state stored in `.dao/`:
- `state.json` — monolithic state snapshot (single source of truth, including all proposals)
- `decisions/NNN.json` — compact decision summaries
- `config.json` — per-project configuration

Previously each proposal was also mirrored in `.dao/proposals/NNN.json` "sidecar" files; that redundant copy has been removed. On the first load after upgrading, any existing sidecars are imported into `state.json` and the `proposals/` directory is removed.

## Adding a New Host

See [docs/EXTENSION-GUIDE.md](docs/EXTENSION-GUIDE.md).

Quick overview:

```typescript
import type { HostAdapter } from "@guyghost/swarm-dao-core";

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
- Lint
- Type checking
- Test execution
- Build verification
- Pi extension npm package validation

Release workflow included (`.github/workflows/publish.yml`):
- Creates Changesets version PRs from `pull_request_target`
- Publishes to npm from `main` via GitHub OIDC trusted publishing

## Documentation

- [ADR-001: Unified Architecture](docs/ADR-001-unified-architecture.md)
- [ADR-002: Hexagonal Functional Core](docs/ADR-002-hexagonal-core.md)
- [Behavioral Models Overview](models/README.md)
- [Extension Guide](docs/EXTENSION-GUIDE.md)
- [Usage Guide](docs/USAGE.md)
- [Agent Prompts](docs/AGENT-PROMPTS.md)
- [XState Proposal Machine](docs/XSTATE_PROPOSAL_MACHINE.md)

## License

MIT
