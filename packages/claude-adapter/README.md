# @guyghost/swarm-dao-claude-adapter

Swarm DAO governance adapter for **Claude Code** (Anthropic).

It bundles:

- the Swarm DAO MCP server (`swarm-dao-claude` bin)
- a native `.mcp.json` template
- a `CLAUDE.md` instructions file
- ready-made slash commands (`/dao-propose`, `/dao-deliberate`, `/dao-ship`)
- a `HostAdapter` implementation for programmatic use

## Install

```bash
npm install @guyghost/swarm-dao-claude-adapter
```

## Configure

### MCP server

Copy `.mcp.json` into your project root. Claude Code auto-detects it and
registers the `swarm-dao` MCP server. The `dao_*` tools then become available
as `mcp__swarm-dao__dao_*`.

### Instructions

Append the contents of `CLAUDE.md` to your repo's `CLAUDE.md` so Claude Code
follows the DAO workflow.

### Slash commands

Copy the `commands/` directory into `.claude/commands/` to enable:

- `/dao-propose` — scaffold a proposal
- `/dao-deliberate` — deliberate and record sub-agent outputs
- `/dao-ship` — control, execute, and ship a proposal

## Run the server directly

```bash
swarm-dao-claude   # uses $DAO_ROOT or cwd
```

## Programmatic API

```ts
import { createClaudeHostAdapter, startClaudeServer } from "@guyghost/swarm-dao-claude-adapter";

const adapter = createClaudeHostAdapter("/path/to/repo");
await startClaudeServer();
```

## License

MIT
