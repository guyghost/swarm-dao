---
"@guyghost/swarm-dao-cli": patch
---

Homebrew distribution via `guyghost/tap` and Node-first shebang.

- Switched the CLI shebang from `#!/usr/bin/env bun` to `#!/usr/bin/env node` — the compiled output uses no Bun-specific APIs, so the CLI now runs on plain Node ≥ 20 (still fully Bun-compatible).
- The CLI is now installable from Homebrew: `brew install guyghost/tap/swarm-dao` (tap auto-syncs to npm releases after Homebrew's 24h security cooldown).
