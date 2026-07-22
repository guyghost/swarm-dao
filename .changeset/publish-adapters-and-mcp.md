---
"@guyghost/swarm-dao-claude-adapter": patch
"@guyghost/swarm-dao-codex-adapter": patch
"@guyghost/swarm-dao-copilot-adapter": patch
"@guyghost/swarm-dao-mcp": patch
---

Publish pending adapter and MCP packages whose last release (0.2.1 / 0.3.1)
failed under npm Trusted Publishing with a registry 404. This patch bump lets
the Release workflow retry the publish once the per-package Trusted Publishers
are configured.
