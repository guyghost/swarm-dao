---
"@guyghost/swarm-dao-improvement": patch
"@guyghost/swarm-dao-pi-adapter": patch
---

Worktree and anchor hardening from dogfood-003 cycle 7 (all four anchors failed on a re-carved worktree):

- A freshly carved series worktree now installs the frozen lockfile (`bun install --frozen-lockfile`) when it is a bun project, on create AND reuse (idempotent). Without it, anchor commands (`bun test`, `bun run`) fail on unresolved imports — c7 lost all four anchors to a missing `xstate`. Non-bun worktrees are skipped; a failed install surfaces through anchor outcome evidence instead of blocking the prepare.
- ANCHOR_RECORDED evidence now joins every line (command + outcome tail) instead of keeping only the first — c7 snapshots recorded just the command, hiding the missing-dependency cause until it was reproduced by hand.
- The Pi adapter tests no longer wipe the host repository's `.dao/` when run from a root-level `bun test`: they chdir into a throwaway git checkout (this exact wipe destroyed dogfood-003's worktree between cycles 6 and 7).
