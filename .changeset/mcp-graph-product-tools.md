---
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-core": patch
---

Expose Graph Engineering and product-loop runs to MCP hosts: `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`. The host hardcodes `source: "ai"` on every submitted signal and only AI-artifact event types are accepted — human events (approvals, rejections, retries, cancellations) stay on the `swarm-dao` CLI human channel. The command registry declares the four new MCP-host commands (mutating submits bound to deterministic tools).
