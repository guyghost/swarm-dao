---
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-pi-adapter": minor
"@guyghost/swarm-dao-graph": minor
"@guyghost/swarm-dao-product": minor
"@guyghost/swarm-dao-core": patch
---

Expose the workflow-run surface to AI hosts end to end.

- New `dao_improve_status` tool (MCP + Pi): read-only improvement series snapshot — state, scope, cooldown, pending reason.
- New Pi tools: `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status` (also reachable as `/dao` subcommands).
- The graph and product packages now export AI-channel submission helpers (`submitAiGraphSignal`, `submitAiProductSignal`) that force `source: "ai"` and restrict event types at the type level; the MCP server uses them instead of building signals itself, so the authority boundary lives inside the packages rather than in host convention.
