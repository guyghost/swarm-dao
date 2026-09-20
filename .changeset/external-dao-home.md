---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-cli": minor
---

External DAO home (ADR-007): git projects no longer get a `.dao/` directory.

DAO state now defaults to `~/.swarm-dao/<project-id>/branches/<branch>/`
(override the root with `SWARM_DAO_HOME`), keyed deterministically from the
realpath of the repo — linked worktrees of one repo share a project, two
clones never do. Config and agent definitions stay shared at the project
root; `state.json`, `decisions/`, and the audit trail are branch-scoped.

- Passive GC removes the state of deleted branches/worktrees on every state
  load; guarded by `project.json.repoPath`, never touching the current
  branch, deletions logged
- `swarm-dao gc [--dry-run]` — explicit sweep behind the same guards
- Projects with an existing `<cwd>/.dao/` keep legacy storage unchanged
  (resolution precedence: legacy `.dao` > home; no git identity also stays
  legacy)

See `docs/ADR-007-external-dao-home.md` for the full decision.
