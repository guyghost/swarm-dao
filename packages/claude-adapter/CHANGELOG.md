# @guyghost/swarm-dao-claude-adapter

## 0.4.0

### Minor Changes

- fd458db: Agents no longer hardcode a model.

  - Removed `model: z.ai/GLM-5.1` from every agent description (`agents/dao-*.md`, `packages/copilot-adapter/agents/*.agent.md`) and dropped the `DEFAULT_AGENT_MODEL` stamp.
  - The model now resolves at dispatch time: agent override (frontmatter `model`) → DAO config default (`DAOConfig.defaultModel`, overridable in `.dao/config.json`) → parent session / host default. Agents without an explicit model inherit the session's model on hosts that support it.

- b08481c: Agent roster grows to 8 with SwarmForge-style role definitions.

  - All seven default agent prompts rewritten in an owns / review-method / rules / does-not-own structure (inspired by unclebob/swarm-forge roles): sharper ownership boundaries, structured review phases, and evidence rules per role.
  - **New default agent: UX/UI Designer** (`designer`, weight 2) — UX/UI critique and improvement directions across the four surface modes (Persuade / Operate / Read / Experience), accessibility review (WCAG AA as defects), and design-direction output. Uses the impeccable harness lenses (impeccable.style) when the host provides it, and the Mobbin MCP server as optional design-reference material (requires a subscription).
  - Per-agent tooling declarations: `tools` frontmatter field in `dao-*.md` is now parsed; the Architect declares `sequential-thinking` (structured step-by-step review), Delivery declares `context7` (library API verification), Designer declares `impeccable` + `mobbin`. Agents degrade gracefully when a tool is not configured by the host.
  - `dao_setup` now seeds 8 agents (new DAOs only; existing DAO state is unchanged).

### Patch Changes

- Updated dependencies [5ee6b0c]
- Updated dependencies [fd458db]
- Updated dependencies [b08481c]
  - @guyghost/swarm-dao-core@0.13.0
  - @guyghost/swarm-dao-mcp@0.8.0

## 0.3.1

### Patch Changes

- Updated dependencies [1538199]
  - @guyghost/swarm-dao-core@0.12.0
  - @guyghost/swarm-dao-mcp@0.7.3

## 0.3.0

### Minor Changes

- 184216d: Expose `dao_improve_once` and the workflow-run surface to every AI host.

  - New `dao_improve_once` tool (MCP + Pi + OpenCode): advances a series by exactly one state-authorized effect through `advanceSeriesOnce` (new improvement export). The host supplies only the series id — the execution environment comes from the persisted `.dao/improvement.json` configuration and workers/anchors run inside the per-series worktree, so an AI host can pull the trigger but never aim it. Human-decision, worker-failed, halted and terminal states are no-ops.
  - Remaining hosts now expose the workflow-run surface: OpenCode gets `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status`, `dao_improve_once` natively; Claude gets generated `/dao:*` slash commands; Codex and Copilot receive the tools through the shared MCP server. The registry entries carry the full AI host set.

### Patch Changes

- Updated dependencies [184216d]
  - @guyghost/swarm-dao-mcp@0.7.0
  - @guyghost/swarm-dao-core@0.11.3

## 0.2.11

### Patch Changes

- Updated dependencies [394fd06]
  - @guyghost/swarm-dao-mcp@0.6.0
  - @guyghost/swarm-dao-core@0.11.2

## 0.2.10

### Patch Changes

- Updated dependencies [42971b0]
  - @guyghost/swarm-dao-mcp@0.5.0
  - @guyghost/swarm-dao-core@0.11.1

## 0.2.9

### Patch Changes

- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0
  - @guyghost/swarm-dao-mcp@0.4.1

## 0.2.8

### Patch Changes

- Updated dependencies [006f8db]
  - @guyghost/swarm-dao-mcp@0.4.0
  - @guyghost/swarm-dao-core@0.10.3

## 0.2.7

### Patch Changes

- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0
  - @guyghost/swarm-dao-mcp@0.3.5

## 0.2.6

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0
  - @guyghost/swarm-dao-mcp@0.3.4

## 0.2.5

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0
  - @guyghost/swarm-dao-mcp@0.3.3

## 0.2.4

### Patch Changes

- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0
  - @guyghost/swarm-dao-mcp@0.3.2

## 0.2.3

### Patch Changes

- Updated dependencies [20a76a2]
  - @guyghost/swarm-dao-core@0.6.0
  - @guyghost/swarm-dao-mcp@0.3.1

## 0.2.2

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

## 0.2.1

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
