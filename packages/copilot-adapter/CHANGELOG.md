# @guyghost/swarm-dao-copilot-adapter

## 0.3.6

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0
  - @guyghost/swarm-dao-mcp@0.3.4

## 0.3.5

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0
  - @guyghost/swarm-dao-mcp@0.3.3

## 0.3.4

### Patch Changes

- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0
  - @guyghost/swarm-dao-mcp@0.3.2

## 0.3.3

### Patch Changes

- Updated dependencies [20a76a2]
  - @guyghost/swarm-dao-core@0.6.0
  - @guyghost/swarm-dao-mcp@0.3.1

## 0.3.2

### Patch Changes

- Updated dependencies [1c20921]
- Updated dependencies [eb686bd]
- Updated dependencies [ecfa79a]
- Updated dependencies [831a124]
- Updated dependencies [ecd1d32]
- Updated dependencies [34fa76e]
- Updated dependencies [c561bb7]
  - @guyghost/swarm-dao-core@0.5.0
  - @guyghost/swarm-dao-mcp@0.3.0

## 0.3.1

### Patch Changes

- Updated dependencies [8b232e9]
- Updated dependencies [ed98280]
- Updated dependencies [7525259]
  - @guyghost/swarm-dao-core@0.4.0
  - @guyghost/swarm-dao-mcp@0.2.1

## 0.2.0

### Minor Changes

- 8e91a15: Add MCP foundation and three host plugins (Copilot, Claude, Codex).

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

### Patch Changes

- Updated dependencies [8e91a15]
  - @guyghost/swarm-dao-core@0.3.0
  - @guyghost/swarm-dao-mcp@0.2.0
