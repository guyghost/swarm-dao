---
"@guyghost/swarm-dao-improvement": patch
---

Fix a ~1/36 flake in the worktree reuse test surfaced by dogfood cycle 8 (metric declined: 2 of 9 main-branch CI runs red).

The `-b` (create-branch) assertion matched the raw git command string, so any mkdtemp suffix starting with "b" (`swarm-worktree-b…`) made the path contain "-b" and failed the branch-reuse expectation. The flag is now matched as an argument token.
