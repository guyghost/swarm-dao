---
"@guyghost/swarm-dao-pi-adapter": minor
"@guyghost/swarm-dao-opencode-adapter": minor
"@guyghost/swarm-dao-core": patch
---

Expose the GitHub integration on the Pi extension and the OpenCode plugin: `dao_config_github`, `dao_github_create_branch`, and `dao_github_open_pr` are now registered as native tools on both hosts (previously CLI + MCP only). The registry entries list `pi` and `opencode`, and the three host-tool handlers now read state through the context repository instead of the process-global legacy bridge.
