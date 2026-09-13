---
"@guyghost/swarm-dao-cli": patch
"@guyghost/swarm-dao-graph": patch
"@guyghost/swarm-dao-improvement": patch
"@guyghost/swarm-dao-product": patch
"@guyghost/swarm-dao-herdr-adapter": patch
"@guyghost/swarm-dao-tmux-adapter": patch
"@guyghost/swarm-dao-mcp": patch
"@guyghost/swarm-dao-pi-adapter": patch
"@guyghost/swarm-dao-opencode-adapter": patch
"@guyghost/swarm-dao-claude-adapter": patch
"@guyghost/swarm-dao-copilot-adapter": patch
"@guyghost/swarm-dao-codex-adapter": patch
---

Fix published manifests: internal dependencies were declared with the `workspace:*` protocol, which `npm publish` does not resolve (only pnpm does). Every install of the affected packages failed with `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`. Restore `^` semver ranges, which changesets bumps automatically on release.
