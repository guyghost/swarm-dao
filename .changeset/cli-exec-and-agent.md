---
"@guyghost/swarm-dao-cli": minor
---

`improve once` gains `--exec branch|worktree|container` (where the series runs: current checkout, an isolated per-series git worktree, or anchor commands in a bounded container) and `--agent <kind>` / `--agent-args` (which herdr agent executable runs the workers — pi, codex, claude, …; also configurable via `worker` in `.dao/improvement.json`).
