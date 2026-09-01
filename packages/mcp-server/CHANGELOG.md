# @guyghost/swarm-dao-mcp

## 0.7.1

### Patch Changes

- e073b9a: `advanceSeriesOnce` (and the `dao_improve_once` tools on MCP, Pi and OpenCode) accepts an optional cycle evidence root, mirroring the CLI's `--cycle-root`. Series that live under `evidence/improvement-series` can now keep their cycles under `evidence/improvement-cycles` instead of splitting across roots. The CLI test that polluted the repo's real evidence roots with a stray `nope` snapshot now uses a temp directory.
- Updated dependencies [e073b9a]
  - @guyghost/swarm-dao-improvement@0.5.0
  - @guyghost/swarm-dao-core@0.11.4

## 0.7.0

### Minor Changes

- 184216d: Expose `dao_improve_once` and the workflow-run surface to every AI host.

  - New `dao_improve_once` tool (MCP + Pi + OpenCode): advances a series by exactly one state-authorized effect through `advanceSeriesOnce` (new improvement export). The host supplies only the series id — the execution environment comes from the persisted `.dao/improvement.json` configuration and workers/anchors run inside the per-series worktree, so an AI host can pull the trigger but never aim it. Human-decision, worker-failed, halted and terminal states are no-ops.
  - Remaining hosts now expose the workflow-run surface: OpenCode gets `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status`, `dao_improve_once` natively; Claude gets generated `/dao:*` slash commands; Codex and Copilot receive the tools through the shared MCP server. The registry entries carry the full AI host set.

### Patch Changes

- Updated dependencies [184216d]
  - @guyghost/swarm-dao-improvement@0.4.0
  - @guyghost/swarm-dao-core@0.11.3

## 0.6.0

### Minor Changes

- 394fd06: Expose the workflow-run surface to AI hosts end to end.

  - New `dao_improve_status` tool (MCP + Pi): read-only improvement series snapshot — state, scope, cooldown, pending reason.
  - New Pi tools: `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status` (also reachable as `/dao` subcommands).
  - The graph and product packages now export AI-channel submission helpers (`submitAiGraphSignal`, `submitAiProductSignal`) that force `source: "ai"` and restrict event types at the type level; the MCP server uses them instead of building signals itself, so the authority boundary lives inside the packages rather than in host convention.

### Patch Changes

- Updated dependencies [394fd06]
  - @guyghost/swarm-dao-graph@0.3.0
  - @guyghost/swarm-dao-product@0.3.0
  - @guyghost/swarm-dao-core@0.11.2

## 0.5.0

### Minor Changes

- 42971b0: Add the read-only `dao_attention` MCP tool: pending human gates across Graph Engineering runs, improvement cycles and series, and product loops, each with its runnable resolution suggestion. The `attention` command registry entry becomes a dual-host (`cli`, `mcp`) command bound to the `dao_attention` tool.

### Patch Changes

- Updated dependencies [42971b0]
  - @guyghost/swarm-dao-core@0.11.1

## 0.4.1

### Patch Changes

- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0
  - @guyghost/swarm-dao-graph@0.2.1
  - @guyghost/swarm-dao-product@0.2.1

## 0.4.0

### Minor Changes

- 006f8db: Expose Graph Engineering and product-loop runs to MCP hosts: `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`. The host hardcodes `source: "ai"` on every submitted signal and only AI-artifact event types are accepted — human events (approvals, rejections, retries, cancellations) stay on the `swarm-dao` CLI human channel. The command registry declares the four new MCP-host commands (mutating submits bound to deterministic tools).

### Patch Changes

- Updated dependencies [006f8db]
  - @guyghost/swarm-dao-core@0.10.3

## 0.3.5

### Patch Changes

- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0

## 0.3.4

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [20a76a2]
  - @guyghost/swarm-dao-core@0.6.0

## 0.3.0

### Minor Changes

- 34fa76e: Wire the `mode` and `criticalPaths` configuration into a deterministic edit gate: `dao_check_edit` (exposed on MCP, Copilot/Claude/Codex adapters, Pi, and OpenCode) lets agents check the files they are about to touch before editing. `opt-in` flags critical paths informationally, `suggest` adds a non-blocking proposal nudge on uncovered critical paths, and `enforce` blocks critical paths unless an approved, controlled, or executed proposal declares them in `affectedPaths`. The gate is pure and read-only — it never edits files and never transitions proposal state. Previously `mode` and `criticalPaths` were documented as reserved schema with no host wiring.

### Patch Changes

- Updated dependencies [1c20921]
- Updated dependencies [eb686bd]
- Updated dependencies [ecfa79a]
- Updated dependencies [831a124]
- Updated dependencies [ecd1d32]
- Updated dependencies [34fa76e]
- Updated dependencies [c561bb7]
  - @guyghost/swarm-dao-core@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [8b232e9]
- Updated dependencies [ed98280]
- Updated dependencies [7525259]
  - @guyghost/swarm-dao-core@0.4.0

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
