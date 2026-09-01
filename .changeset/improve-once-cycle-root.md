---
"@guyghost/swarm-dao-improvement": minor
"@guyghost/swarm-dao-mcp": patch
"@guyghost/swarm-dao-pi-adapter": patch
"@guyghost/swarm-dao-opencode-adapter": patch
"@guyghost/swarm-dao-core": patch
---

`advanceSeriesOnce` (and the `dao_improve_once` tools on MCP, Pi and OpenCode) accepts an optional cycle evidence root, mirroring the CLI's `--cycle-root`. Series that live under `evidence/improvement-series` can now keep their cycles under `evidence/improvement-cycles` instead of splitting across roots. The CLI test that polluted the repo's real evidence roots with a stray `nope` snapshot now uses a temp directory.
