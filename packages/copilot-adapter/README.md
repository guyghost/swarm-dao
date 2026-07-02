# @guyghost/swarm-dao-copilot-adapter

Swarm DAO governance adapter for **GitHub Copilot** (VS Code Copilot Chat,
Copilot CLI, and the Copilot coding agent).

It bundles:

- the Swarm DAO MCP server (`swarm-dao-copilot` bin)
- a native `.vscode/mcp.json` template
- Copilot custom instructions (`copilot-instructions.md`)
- a `HostAdapter` implementation for programmatic use

## Install

```bash
npm install @guyghost/swarm-dao-copilot-adapter
```

## Configure

### VS Code Copilot Chat

Copy `.vscode/mcp.json` into your project (it registers the `swarm-dao` MCP
server). Restart VS Code, then the `dao_*` tools appear under the `swarm-dao`
MCP server in Copilot Chat.

### Custom instructions

Append the contents of `copilot-instructions.md` to your repo's
`.github/copilot-instructions.md` so Copilot follows the DAO workflow.

## Run the server directly

```bash
swarm-dao-copilot   # uses $DAO_ROOT or cwd
```

## Programmatic API

```ts
import { createCopilotHostAdapter, startCopilotServer } from "@guyghost/swarm-dao-copilot-adapter";

const adapter = createCopilotHostAdapter("/path/to/repo");
await startCopilotServer(); // boots the stdio MCP server
```

## Workflow

See [`copilot-instructions.md`](./copilot-instructions.md) for the full
DAO workflow (setup → propose → deliberate → dispatch → record → control →
execute → ship).

## License

MIT
