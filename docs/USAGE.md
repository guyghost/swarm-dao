# Swarm DAO Usage Guide

> Installation, configuration, and complete workflows for Pi, OpenCode, and MCP hosts (Cursor, Cline, Claude Code, Continue).

---

## Table of Contents

- [Installation in Pi](#installation-in-pi)
- [Installation in OpenCode](#installation-in-opencode)
- [Installation via MCP (Cursor, Cline, Claude Code, Continue)](#installation-via-mcp-cursor-cline-claude-code-continue)
- [Common Workflows](#common-workflows)
- [Host Comparison](#host-comparison)
- [Troubleshooting](#troubleshooting)

---

## Installation in Pi

### Prerequisites

- [Pi coding agent](https://pi.dev) installed (`pi` CLI)
- Bun ≥ 1.3
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/guyghost/swarm-dao.git ~/swarm-dao
cd ~/swarm-dao
bun install
bun add typebox
```

### 2. Link the Workspace Package

Bun workspaces do not always create a physical symlink in `node_modules/`. Create it manually so the extension can resolve `@guyghost/swarm-dao-core`:

```bash
mkdir -p node_modules/@guyghost
ln -s ../../packages/core node_modules/@guyghost/swarm-dao-core
```

### 3. Register the Extension

Create a symlink so Pi discovers the extension automatically:

```bash
mkdir -p .pi/extensions
ln -s ../../packages/pi-adapter/src/index.ts .pi/extensions/swarm-dao.ts
```

Or install globally:

```bash
mkdir -p ~/.pi/agent/extensions/swarm-dao
ln -s ~/swarm-dao/packages/pi-adapter/src/index.ts ~/.pi/agent/extensions/swarm-dao/index.ts
```

### 4. Start Pi

```bash
pi
```

Pi will auto-discover the extension from `.pi/extensions/` (project-local) or `~/.pi/agent/extensions/` (global).

### 5. Initialize the DAO

Inside the Pi session:

```
> dao_setup

# DAO Initialized
# 7 agents configured:
# | Product Strategist | 3 | Vision, objectives, hypotheses |
# | Research Agent     | 2 | Market, competition, user signals |
# | Solution Architect | 3 | Technical options, tradeoffs |
# | Critic / Risk Agent| 3 | Risk scoring, objections, guardrails |
# | Prioritization Agent| 2 | Impact/cost/risk scoring |
# | Spec Writer        | 1 | PRD, user stories, acceptance criteria |
# | Delivery Agent     | 1 | Implementation plan, tasks, CI/CD |
```

### 6. Verify Installation

```
> /dao help

# /dao Help
# Use `/dao` with one of these subcommands:
# - `/dao` or `/dao status` — show dashboard summary.
# - `/dao help` — show this help.
# - `/dao setup` — initialize DAO directly from the slash command.

> /dao

# Swarm DAO Dashboard
# Agents: 7 | Proposals: 0
```

---

## Installation in OpenCode

### Prerequisites

- OpenCode CLI (`opencode`) installed (≥ 1.14.19)
- Bun ≥ 1.3

### 1. Clone the Repository

```bash
git clone https://github.com/guyghost/swarm-dao.git ~/.config/opencode/plugins/swarm-dao
cd ~/.config/opencode/plugins/swarm-dao
bun install
```

### 2. Activate the Plugin

In your project, edit `.opencode/config.json`:

```json
{
  "plugins": ["swarm-dao"]
}
```

Or via CLI:

```bash
opencode plugin install swarm-dao
```

### 3. Launch OpenCode

```bash
opencode
```

### 4. Initialize the DAO

```
> dao_setup

# DAO Initialized
# 7 agents configured
# Run `dao_help` to discover the workflow, then `dao_propose` to create proposals.

> dao_help

# DAO Help
# Recommended flow and tool discovery
```

### 5. Verify Installation

```
> dao_dashboard

# DAO Dashboard
# Health: ...
# Proposal overview: ...
# Config: quorum=60%, approval=55%, risk=7/10
```

---

## Installation via MCP (Cursor, Cline, Claude Code, Continue)

The [`@guyghost/swarm-dao-mcp`](../packages/mcp-server) package exposes all DAO tools over the Model Context Protocol. One server works across any MCP-compatible host.

### Prerequisites

- Bun ≥ 1.3 (for `bunx`)
- Your host IDE/agent with MCP support

### Cursor

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "swarm-dao": {
      "command": "bunx",
      "args": ["@guyghost/swarm-dao-mcp"],
      "env": {
        "DAO_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

Reload Cursor. DAO tools appear under MCP in the agent panel.

### Cline

Open **MCP Servers → Configure → Configure MCP Servers** and add:

```json
{
  "mcpServers": {
    "swarm-dao": {
      "command": "bunx",
      "args": ["@guyghost/swarm-dao-mcp"],
      "env": { "DAO_ROOT": "/absolute/path/to/your/project" },
      "disabled": false
    }
  }
}
```

### Claude Code

Use the bundled plugin at [`packages/claude-code-adapter`](../packages/claude-code-adapter):

```bash
claude plugin add /path/to/swarm-dao/packages/claude-code-adapter
```

Or copy the `.mcp.json` from that package into your project `.claude/` settings.

### Continue

Add to `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: swarm-dao
    command: bunx
    args:
      - "@guyghost/swarm-dao-mcp"
    env:
      DAO_ROOT: /absolute/path/to/your/project
```

### MCP workflow (manual deliberation)

MCP hosts use the same two-step deliberation as OpenCode:

1. `dao_setup`
2. `dao_propose`
3. `dao_deliberate` — returns dispatch plan with per-agent prompts
4. Spawn sub-agents via your host's **Task** or **Agent** tool
5. `dao_record_outputs` — submit outputs for voting and synthesis
6. `dao_control` → `dao_execute` (or `dao_ship` with dependency cascade)

Set `DAO_GITHUB_TOKEN` after `dao_config_github` to avoid re-entering tokens.

---

## Common Workflows

### Workflow 1: Create and Deliberate a Proposal

#### In Pi:

```
# Step 1: Create a proposal
> dao_propose
  title="Add dark mode"
  type="product-feature"
  description="Implement a dark theme for the application"
  problemStatement="Users request dark mode for night usage"
  acceptanceCriteria=["Toggle works", "Persists preference"]
  successMetrics=["Adoption > 50%"]

# 📋 Proposal Created — #1

# Step 2: Deliberate (swarm vote)
> dao_deliberate proposalId=1

# 🗳️ Deliberation Complete — #1
# Result: ✅ APPROVED
# Quorum: 85% / ✅ Met
# Approval Score: 73%

# Step 3: Quality control
> dao_check proposalId=1

# ✅ ALL GATES PASSED

# Step 4: Ship (execute, with dependency check)
> dao_ship proposalId=1

# 🚀 Ship Complete
# Shipped proposals:
# - #1
```

#### In OpenCode:

```
# Step 1: Create a proposal
> dao_propose
  title="Add dark mode"
  type="product-feature"
  description="Implement a dark theme"

# 📋 Proposal Created — #1

# Step 2: Deliberate (returns a dispatch plan)
> dao_deliberate proposalId=1

# 🐝 Dispatch Plan — Proposal #1
# Agents to spawn: 7
# ### @strategist
# Spawn this sub-agent with the following task...

# Step 3: Manually run sub-agents via `task`,
# then record outputs
> dao_record_outputs
  proposalId=1
  outputs=[
    { agentId: "strategist",
      content: "## Analysis...\n## Vote\nfor\n## Reasoning..." },
    { agentId: "architect",
      content: "## Analysis...\n## Vote\nfor\n## Reasoning..." },
    ...
  ]

# 🗳️ Deliberation Complete — #1

# Step 4: Control + Execute
> dao_control proposalId=1
> dao_execute proposalId=1
```

### Workflow 2: Round Table (Agents Suggest Ideas)

#### In Pi:

```
> dao_roundtable

# 🎯 Round Table Results
# Suggestions: 5 valid / 0 unparsed / 0 errors
#
# ## Product Strategist
# **Title:** Add search functionality
# **Type:** product-feature
#
# ## Solution Architect
# **Title:** Migrate to TypeScript strict mode
# **Type:** technical-change
#
# **Created:** Proposals #2, #3, #4, #5, #6
```

#### In OpenCode:

```
> dao_roundtable

# Same result — agents are spawned automatically
# via the OpenCode adapter
```

### Workflow 3: Dry-Run and Rollback

```
# Preview before executing
> dao_dry_run proposalId=1

# 🔍 Dry-Run — Proposal #1
# Can Proceed: ✅ Yes
# Files Affected: src/theme.ts, src/components/
# Risks: None identified

# Execute
> dao_execute proposalId=1

# If problem: rollback
> dao_rollback proposalId=1

# ⏪ Rollback Successful
# Proposal #1 rolled back to commit abc123de
```

### Workflow 4: Dashboard and Artefacts

```
# View dashboard
> dao_dashboard

# 🏛️ DAO Dashboard
# Proposals: 15 total
# Health: 78/100 Stable
# | Pass Rate      | ████████░░ 80% |
# | Avg Rating     | ████████░░ 78% |

# Generate artefacts
> dao_artefacts proposalId=5

# 📦 Artefacts — Proposal #5
# | Decision Brief      | ✅ |
# | ADR                 | ✅ |
# | Risk Report         | ✅ |
# | PRD Lite            | ✅ |
# | Implementation Plan | ✅ |
# | Test Plan           | ✅ |
# | Release Packet      | ✅ |
```

### Workflow 5: GitHub Integration

```
# Configure
> dao_config_github
  token="ghp_xxx"
  owner="myorg"
  repo="myrepo"
  enabled=true

# Create branch
> dao_github_create_branch proposalId=1

# ✅ Branch ready
# Ref: refs/heads/dao/1-add-dark-mode

# Push code, then open PR
> dao_github_open_pr
  proposalId=1
  headBranch="dao/1-add-dark-mode"

# ✅ Pull Request Opened
# PR: #42
# URL: https://github.com/myorg/myrepo/pull/42
```

---

## Host Comparison

| Aspect | Pi | OpenCode | MCP (Cursor, Cline, …) |
|--------|-----|----------|------------------------|
| **Integration** | Pi Extension | OpenCode Plugin | MCP stdio server |
| **Install** | `.pi/extensions/` | `opencode.json` plugins | `.cursor/mcp.json`, etc. |
| **Deliberation** | Automatic (`dispatchSwarm`) | Manual plan + `task` | Manual plan + Task/Agent |
| **Control tool** | `dao_check` | `dao_control` | `dao_control` |
| **Ship tool** | `dao_ship` (cascade) | `dao_execute` / `dao_ship` | `dao_execute` / `dao_ship` |
| **GitHub tools** | `dao_config_github`, … | `dao_config_github`, … | `dao_config_github`, … |

### Why is deliberation different?

**Pi** can spawn native Pi sub-processes:
```typescript
// In pi-adapter
await adapter.spawnAgent({ agent, proposal, systemPrompt });
// → Runs `pi --mode json -p --no-session ...`
```

**OpenCode** cannot spawn programmatically:
```typescript
// In opencode-adapter
// Step 1: dao_deliberate returns a markdown dispatch plan
// Step 2: User spawns @dao-strategist via `task`
// Step 3: dao_record_outputs ingests the results
```

---

## Troubleshooting

### Pi: "DAO not initialized"

```
> dao_setup
```

### Pi: "Cannot find module '@guyghost/swarm-dao-core'"

Check the symlink:
```bash
ls -la node_modules/@guyghost/swarm-dao-core
# Should point to packages/core
```

If missing, recreate it:
```bash
mkdir -p node_modules/@guyghost
ln -s ../../packages/core node_modules/@guyghost/swarm-dao-core
```

### OpenCode: "Plugin not found"

Check the plugin path:
```bash
ls ~/.config/opencode/plugins/swarm-dao/
# Should contain package.json, src/, etc.
```

### Agents do not respond

Check the configured model:
```
> dao_config_show
```

### TypeScript compilation error

```bash
cd packages/core && npx tsc --noEmit
cd packages/pi-adapter && npx tsc --noEmit
cd packages/opencode-adapter && npx tsc --noEmit
```

### Full Reset

```bash
rm -rf .dao/
# Then re-initialize
dao_setup
```

---

## Quick Command Reference

| Command | Pi | OpenCode | MCP | Description |
|---------|-----|----------|-----|-------------|
| Initialize | `dao_setup` | `dao_setup` | `dao_setup` | Create the 7 default agents |
| Propose | `dao_propose` | `dao_propose` | `dao_propose` | Create a proposal |
| Deliberate | `dao_deliberate` | `dao_deliberate` + `dao_record_outputs` | same as OpenCode | Swarm vote |
| Control | `dao_check` | `dao_control` | `dao_control` | Quality gates |
| Execute | `dao_ship` | `dao_execute` | `dao_execute` / `dao_ship` | Execute / ship proposal |
| GitHub | `dao_config_github` | `dao_config_github` | `dao_config_github` | Configure GitHub |
| Rate | `dao_rate` | `dao_rate` | `dao_rate` | Post-execution rating |
| Help | `/dao help` | `dao_help` | `dao_help` | Onboarding + discovery |
| Rollback | `dao_rollback` | `dao_rollback` | Revert execution |
| Roundtable | `dao_roundtable` | `dao_roundtable` | Agent suggestions |
| Audit | `dao_audit` | `dao_audit` | History |
| Status | `/dao` / `/dao status` | `dao_dashboard` | Quick dashboard |
| Help | `/dao help` | *(n/a)* | Onboarding + command discovery |

---

## Next Steps

- [Configure agents](AGENT-PROMPTS.md)
- [Add a new host](EXTENSION-GUIDE.md)
- [Detailed architecture](ADR-001-unified-architecture.md)
