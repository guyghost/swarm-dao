# @guyghost/swarm-dao-codex-adapter

Swarm DAO governance adapter for **OpenAI Codex** (Codex CLI).

It bundles:

- the Swarm DAO MCP server (`swarm-dao-codex` bin)
- a native `config.toml` snippet for `[mcp_servers]`
- an `AGENTS.md` instructions file
- a `HostAdapter` implementation for programmatic use

## Install

```bash
npm install @guyghost/swarm-dao-codex-adapter
```

## Configure

### MCP server

Append the block from `config/mcp-config.toml` to your Codex config
(`~/.codex/config.toml` or the project-local config):

```toml
[mcp_servers.swarm_dao]
command = "npx"
args = ["-y", "@guyghost/swarm-dao-codex-adapter"]
env = { DAO_ROOT = "." }
```

The `dao_*` tools then become available to Codex as the `swarm_dao` MCP server.

### Instructions

Append the contents of `AGENTS.md` to your repo's `AGENTS.md` so Codex follows
the DAO workflow.

## Run the server directly

```bash
swarm-dao-codex   # uses $DAO_ROOT or cwd
```

## Programmatic API

```ts
import { createCodexHostAdapter, startCodexServer } from "@guyghost/swarm-dao-codex-adapter";

const adapter = createCodexHostAdapter("/path/to/repo");
await startCodexServer();
```

## License

MIT
