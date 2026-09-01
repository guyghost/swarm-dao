---
"@guyghost/swarm-dao-improvement": patch
"@guyghost/swarm-dao-mcp": patch
"@guyghost/swarm-dao-pi-adapter": patch
"@guyghost/swarm-dao-opencode-adapter": patch
---

Post-dogfood hardening (dogfood-003 cycle 6 findings):

- Worker retries now close herdr workspaces left behind by a run killed mid-flight (host timeout, crash) before carving a fresh one — deterministic labels make lingering same-label workspaces orphans, so retries converge instead of accumulating panes.
- `dao_improve_once` tool descriptions and the MCP README now state that worker phases take minutes and hosts must raise their request timeout (MCP clients default to 60s and kill the call mid-flight).
