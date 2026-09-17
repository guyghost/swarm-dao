---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-graph": minor
"@guyghost/swarm-dao-cli": patch
"@guyghost/swarm-dao-mcp": patch
"@guyghost/swarm-dao-pi-adapter": patch
"@guyghost/swarm-dao-opencode-adapter": patch
---

Graph Engineering retries after failed evaluation are now system-owned: EVALUATE / IMPLEMENTATION_FAILED with remaining budget auto-continue to implementing. There is no RETRY_AUTHORIZED human event on a graph run; model-hash approval and cancel stay human.
