---
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-pi-adapter": minor
"@guyghost/swarm-dao-opencode-adapter": minor
"@guyghost/swarm-dao-claude-adapter": minor
"@guyghost/swarm-dao-improvement": minor
"@guyghost/swarm-dao-core": patch
---

Expose `dao_improve_once` and the workflow-run surface to every AI host.

- New `dao_improve_once` tool (MCP + Pi + OpenCode): advances a series by exactly one state-authorized effect through `advanceSeriesOnce` (new improvement export). The host supplies only the series id — the execution environment comes from the persisted `.dao/improvement.json` configuration and workers/anchors run inside the per-series worktree, so an AI host can pull the trigger but never aim it. Human-decision, worker-failed, halted and terminal states are no-ops.
- Remaining hosts now expose the workflow-run surface: OpenCode gets `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status`, `dao_improve_once` natively; Claude gets generated `/dao:*` slash commands; Codex and Copilot receive the tools through the shared MCP server. The registry entries carry the full AI host set.
