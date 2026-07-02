---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-copilot-adapter": minor
"@guyghost/swarm-dao-claude-adapter": minor
"@guyghost/swarm-dao-codex-adapter": minor
---

Add MCP foundation and three host plugins (Copilot, Claude, Codex).

- **core**: reconstruct the shared `host-tools` handler layer as TypeScript
  source (messages, utils, github-config, handlers) and export it from the
  package barrel.
- **mcp-server** (new): expose the full Swarm DAO toolset (23 tools) as a
  stdio MCP server, built on the shared handler layer. Manual deliberation
  mode (`dao_deliberate` → spawn sub-agents → `dao_record_outputs`).
- **copilot-adapter** (new): GitHub Copilot plugin — `swarm-dao-copilot` bin,
  `.vscode/mcp.json`, `copilot-instructions.md`, `HostAdapter`.
- **claude-adapter** (new): Claude Code plugin — `swarm-dao-claude` bin,
  `.mcp.json`, `CLAUDE.md`, slash commands (`/dao-propose`, `/dao-deliberate`,
  `/dao-ship`), `HostAdapter`.
- **codex-adapter** (new): OpenAI Codex plugin — `swarm-dao-codex` bin,
  `config.toml` snippet, `AGENTS.md`, `HostAdapter`.
