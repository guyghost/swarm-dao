---
"@guyghost/swarm-dao-improvement": minor
---

Add worktree execution environments and configurable herdr worker agents.

- `ensureSeriesWorktree`: idempotent per-series git worktree (branch `dao/loop/<series-id>`, path `.dao/worktrees/<series-id>`), re-syncing the gitignored `.dao/improvement.json` into the worktree on every prepare.
- `OrchestratorOnceDeps.worker` threads the herdr agent kind and extra args to the default worker executor; only `pi` defaults to `-ne`, other kinds (codex, claude, …) start with their own defaults. `SAFE_HERDR_KIND` is exported for host validation.
