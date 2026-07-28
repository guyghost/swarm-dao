# @guyghost/swarm-dao-mcp

Swarm DAO governance as an **MCP (Model Context Protocol)** stdio server.
Exposes the full Swarm DAO toolset — propose, deliberate, control, execute,
ship, rollback, audit — as MCP tools that any MCP-compatible host can call.

> **Integrating a host?** Read [`docs/MCP_INTEGRATION.md`](../../docs/MCP_INTEGRATION.md)
> — the canonical workflow, spawn patterns, and operating rules shared by all
> adapters (Copilot, Claude Code, Codex, and this server).

## Install

```bash
npm install @guyghost/swarm-dao-mcp
```

## Run

```bash
# Boots the stdio MCP server, using $DAO_ROOT (or cwd) as the DAO root.
swarm-dao-mcp
```

## Configure in a host

Any MCP host can register this server. Example (VS Code / Claude / generic):

```json
{
  "mcpServers": {
    "swarm-dao": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@guyghost/swarm-dao-mcp"],
      "env": { "DAO_ROOT": "." }
    }
  }
}
```

For ready-made host packages (native config + instructions + slash commands),
see the sibling adapters:

- [`@guyghost/swarm-dao-copilot-adapter`](../copilot-adapter)
- [`@guyghost/swarm-dao-claude-adapter`](../claude-adapter)
- [`@guyghost/swarm-dao-codex-adapter`](../codex-adapter)

## Tools

23 tools covering the full governance lifecycle:

| Group | Tools |
| --- | --- |
| Onboarding | `dao_help`, `dao_setup` |
| Proposals | `dao_propose`, `dao_update_proposal`, `dao_propose_amendment`, `dao_list` |
| Deliberation | `dao_deliberate`, `dao_record_outputs`, `dao_roundtable` |
| Delivery | `dao_plan`, `dao_artefacts`, `dao_dry_run`, `dao_control`, `dao_execute`, `dao_ship`, `dao_rollback` |
| Tracking | `dao_dashboard`, `dao_audit`, `dao_rate` |
| Agents | `dao_agents` |
| GitHub | `dao_config_github`, `dao_github_create_branch`, `dao_github_open_pr` |

## Programmatic API

```ts
import { createSwarmDaoMcpServer, ensureDaoStorage, createMcpHostAdapter } from "@guyghost/swarm-dao-mcp";

await ensureDaoStorage("/path/to/repo");
const server = createSwarmDaoMcpServer("/path/to/repo");
await server.connect(yourTransport);
```

## How deliberation works over MCP

MCP hosts cannot have the server spawn sub-agents, so Swarm DAO uses
**manual deliberation** here:

1. `dao_deliberate` returns a dispatch plan (agents + models).
2. The host spawns one sub-agent per plan entry itself.
3. `dao_record_outputs` feeds the sub-agent outputs back into the DAO.

## License

MIT
