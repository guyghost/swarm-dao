# Swarm DAO — Claude Code Plugin

Thin Claude Code plugin that wires the [`@guyghost/swarm-dao-mcp`](../../mcp-server) server and session guidance for deliberation.

## Install

1. Install the MCP server globally or use `bunx`:

   ```bash
   bun add -g @guyghost/swarm-dao-mcp
   ```

2. Add this plugin directory to Claude Code (local plugin path):

   ```bash
   claude plugin add /path/to/swarm-dao/packages/claude-code-adapter
   ```

   Or copy `.mcp.json` into your project's `.claude/` settings and point `DAO_ROOT` at your repo root.

## Deliberation workflow

Claude Code can spawn sub-agents via the **Agent** tool:

1. `dao_deliberate` — get per-agent prompts and models
2. **Agent** tool — run each sub-agent with the provided prompt
3. `dao_record_outputs` — submit collected outputs for voting and synthesis

## Contents

| Path | Purpose |
|------|---------|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.mcp.json` | MCP server registration |
| `hooks/hooks.json` | SessionStart guidance for DAO workflow |
