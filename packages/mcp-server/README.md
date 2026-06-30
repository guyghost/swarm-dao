# @guyghost/swarm-dao-mcp

> Universal MCP server for Swarm DAO — works with Cursor, Cline, Claude Code, Continue, and any MCP-compatible host.

## Install

```bash
bun add -g @guyghost/swarm-dao-mcp
# or use without global install:
bunx @guyghost/swarm-dao-mcp
```

## Cursor

Add to `.cursor/mcp.json` in your project:

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

## Cline

Add to `cline_mcp_settings.json`:

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

## Workflow (manual deliberation)

MCP hosts do not auto-spawn sub-agents. Use the two-step deliberation flow:

1. `dao_setup`
2. `dao_propose`
3. `dao_deliberate` — returns a dispatch plan
4. Run sub-agents via your host's Task/Agent tool
5. `dao_record_outputs` — finalize votes and synthesis
6. `dao_control` → `dao_execute`

## Tools

21 tools including governance, deliberation, delivery, GitHub integration (`dao_config_github`, `dao_github_create_branch`, `dao_github_open_pr`), and observability.

See [docs/USAGE.md](../../docs/USAGE.md) for the full reference.
