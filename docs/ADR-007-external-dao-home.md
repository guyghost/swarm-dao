# ADR-007: External DAO Home — `~/.swarm-dao/<project>/<branch>` Instead of In-Repo `.dao/`

## Status

Accepted (2026-09-20) — implemented in the same change set:

- **core**: `adapters/dao-home/` (pure naming + resolution + GC),
  `persistence.ts` (`initStorage`, storage settings), `config.ts`
  (project-config resolution), `FileDaoStateRepository.open`,
  `commands/registry.ts` (`gc`);
- **cli**: layout-aware `init` / config / github / deliberate paths,
  `swarm-dao gc [--dry-run]`;
- **tests**: `packages/core/tests/dao-home.test.ts` (naming, precedence,
  passive GC + guards, explicit gc, repository/config wiring).

Deferred follow-ups: the one-shot `dao migrate --to home` command (legacy
projects keep working via precedence rule 2 in the meantime) and evidence
root relocation (see Open questions). Note: proposing on a fresh branch
requires `dao_setup` on that branch — the initialized flag is branch-scoped
state under this layout. This ADR changes **where** DAO state
lives and **when** it is cleaned up. It changes **no** state machine: the
proposal machine and the Graph Engineering model keep their current
transitions, anchors, and permissions. This is a persistence-path concern
inside the hexagonal adapters (ADR-002).

## Context

`getDaoRoot(cwd)` in `packages/core/src/persistence.ts` resolves storage as
`path.join(cwd, ".dao")`. Three consequences:

1. **Host projects get polluted by default.** Any project that runs
   `dao_setup` receives a `.dao/` directory it did not ask for. Projects that
   do not want DAO artifacts must add `.dao/` (and the legacy
   `.opencode-dao/`) to `.gitignore`, and the directory still shows up in
   tree views, search tools, and `.gitignore` diffs forever.
2. **No branch isolation.** In the main checkout, `state.json`,
   `decisions/`, and the audit trail are shared across *all* branches.
   Proposals created on a feature branch pollute `main`'s state and are
   visible from every other branch checked out in that directory.
3. **No cleanup story.** A linked worktree gets its own `.dao/` *inside the
   worktree directory*, so `git worktree remove` silently destroys that
   worktree's proposals and audit trail. Conversely, state accumulated at the
   main root persists forever with no garbage collection — for branches that
   were deleted long ago.

There is a precedent for per-branch DAO state being the right grain: the
github-sync storage modes (`local | github | hybrid`) already exist, and
evidence roots (`evidence/graph-runs/`, etc.) are branch-scoped work products.

## Decision

### 1. Default home moves outside the repository

The default DAO home becomes:

```
~/.swarm-dao/<project-id>/
```

chosen at init time (`dao_setup` / `initStorage`). An in-repo `.dao/` remains
available as an explicit opt-in (legacy projects, and projects using the
github-sync modes, which by nature require state inside the repo).

Resolution precedence (first match wins):

1. `<cwd>/.dao/` exists → use it (legacy projects keep working unchanged)
2. git repo → `~/.swarm-dao/<project-id>/` (new default; `SWARM_DAO_HOME`
   overrides the home root)
3. no git identity → legacy `<cwd>/.dao` (fail-closed: home mode needs a
   git-derived project identity)

### 2. Deterministic project identity — no registry index

```
project-id = slug(basename(repo-root)) + "-" + sha256(realpath(git-common-dir))[0..8]
```

Example: `swarm-dao-a1b2c3d4`.

- The git *common dir* (main checkout's `.git`), realpath-resolved, is the
  identity anchor: linked worktrees of the same repo map to the same
  project-id; two clones of the same repo at different paths get different
  ids; symlinked paths normalize through `realpath`.
- The id is fully derivable — no index file to corrupt, no lookup to lose.

### 3. Layout: project-level config, branch-level state

```
~/.swarm-dao/<project-id>/
├── project.json                  # schemaVersion, repoPath, createdAt, storageMode
├── config.json                   # ProjectConfig — shared across branches
├── branches/
│   ├── main/
│   │   ├── state.json            # proposals (existing DAOState format)
│   │   ├── decisions/            # existing per-proposal summaries
│   │   └── audit.jsonl           # existing audit trail
│   └── feat-external-home/
│       └── …
└── detached-a1b2c3d/             # detached-HEAD sessions, keyed by short sha
```

- **Branch id**: the checked-out branch name
  (`git rev-parse --abbrev-ref HEAD`). A branch can be checked out in at most
  one worktree, so the branch key already disambiguates worktrees; detached
  HEADs fall back to `detached-<shortsha>`. Projects without a git identity
  never enter home mode (see precedence above).
- **Why config is shared**: agent definitions, activation mode, and remote
  config do not vary per branch; duplicating them per branch forces users to
  re-run setup on every branch and risks config drift between branches.
  State (proposals, decisions, audit) *is* branch-scoped work and moves
  per-branch. (`state.json` format is unchanged — only its location moves.)

### 4. Init-time choice

`dao_setup` records the decision in `~/.swarm-dao/<project-id>/project.json`
(`storageMode: "home" | "repo"`). Defaults:

- `home` (external) — new default.
- `repo` (in-repo `.dao/`) — when the user opts out, or when github sync is
  enabled at setup time (synced state must live in the repo).

### 5. Cleanup: passive GC, not git hooks

Git has no native branch-deletion hook, and installing per-repo hooks would
reintroduce exactly the in-project footprint this ADR removes. Instead,
cleanup is **garbage collection driven by live git state**:

- **Passive GC** runs whenever the DAO home is resolved (state load, setup,
  `dao_check`): list live refs (`git for-each-ref refs/heads`) and worktrees
  (`git worktree list --porcelain`), then delete `branches/<id>/` and
  `detached-*` directories that match neither. Guards:
  - never GC the current branch's directory;
  - only run when `project.json.repoPath` matches the current repo (prevents
    a moved/renamed project from wiping another project's state);
  - skip silently when git metadata is unavailable (non-git project);
  - deletions are logged (what was removed, not silently).
- **Explicit command**: `swarm-dao gc [--dry-run]` for manual sweeps.

Branch rename appears as delete + create and is handled by the same GC.
This is idempotent, host-agnostic, and requires zero footprint in the host
project — including in `.git/hooks`.

### 6. Scope guard

No changes to: `DaoStateRepositoryPort`, the proposal machine
(`models/`, `packages/core/src/models/`), the Graph Engineering model, or any
host-adapter interface. `loadConfig(daoRoot)` / `saveConfig(daoRoot)`
signatures stay valid — they simply receive the project-level dir for config
and the branch dir for state.

## Affected code

| Area | File | Change |
|---|---|---|
| Path resolution | `packages/core/src/persistence.ts` | `getDaoRoot` → resolver (env > legacy `.dao` > home); `initStorage` writes `project.json`; GC hooks in state load |
| Naming (pure) | new `packages/core/src/adapters/dao-home/` | `project-id` derivation, branch-id resolution, GC diff — pure functions, unit-testable |
| Git queries | `packages/core/src/adapters/git-workspace.ts` | extend with branch list / worktree list / common-dir resolution |
| Config | `packages/core/src/config.ts` | no signature change; config dir = project root |
| Setup | `dao_setup` in each host adapter, CLI `setup` | storage-mode choice, default `home`; auto-`repo` when github sync enabled |
| Evidence roots | `packages/core/src/observability/attention.ts` (`PROJECT_LOCAL_ROOTS`) | scan moves under the resolved branch dir |
| Migration | CLI | `swarm-dao dao migrate --to home` (optional, one-shot) |

## Migration & compatibility

- Existing projects with an in-repo `.dao/`: **untouched** — precedence rule
  2 keeps them on legacy mode with zero action.
- Moving an existing project to home mode: `dao migrate --to home` copies
  `state.json` + `decisions/` + audit into `branches/<current>/`, merges
  config at project level, and marks `storageMode: "home"`.
- Fresh setups get `home` by default; `dao_setup` prints the resolved home
  path so the location is always discoverable (`dao_status` shows it too).

## Consequences

**Positive**

- Host projects stay clean by default — no `.dao/`, no `.gitignore` entry,
  nothing to remove when a project opts out entirely.
- Branch isolation: proposals, deliberations, and audit trails are scoped to
  the branch that produced them.
- Worktree removal no longer destroys DAO state; deletion becomes explicit
  and observable via GC.
- Two checkouts of the same repo never share state.

**Negative / risks**

- State is less discoverable (not next to the code). Mitigations:
  `project.json` records the repo path, `dao_status` echoes the home, and
  `SWARM_DAO_HOME` gives full control.
- Backing up DAO state becomes the user's responsibility (it no longer rides
  along with the repo except via github-sync mode, which keeps in-repo
  storage).
- Merging branches does not merge DAO state: proposals created on a feature
  branch live in that branch's dir. Acceptable for now — governance work is
  branch-scoped by design; a cross-branch proposal move (`dao migrate-branch`)
  is future work if needed.
- GC deletes state for deleted branches. This is the requested behavior
  (le ménage), but it means a deleted branch's proposals are gone. `--dry-run`
  and deletion logging bound the blast radius; a retention window
  (`gc.retentionDays`) is deliberately **not** included in v1.

## Open questions

1. **Detached-HEAD churn** — short-sha keys accumulate for exploratory
   checkouts; passive GC prunes them with the same live-ref diff, so this is
   expected to self-heal.
3. **Evidence roots per branch vs per project** — graph/improvement evidence
   follows the branch dir in v1; if cross-branch evidence aggregation becomes
   painful, promote evidence to project level in a follow-up.

> Resolved during review: the home root is `~/.swarm-dao/` (tool-specific
> name, no clash risk with other "dao" tools), overridable via
> `SWARM_DAO_HOME`. Shared project-level config is confirmed (§3) — only
> state (proposals, decisions, audit) is branch-scoped; GC deletes closed
> branch state permanently in v1, no retention window.

## Verification plan

RED-first contract tests in `packages/core` (per the repo's test discipline):

1. `project-id` derivation: same repo via worktree → same id; second clone →
   different id; symlink → same id (realpath).
2. Resolution precedence: env var > legacy `.dao` > home.
3. GC: deletes only non-live branch dirs, never current, never when
   `project.json.repoPath` mismatches, no-op on non-git dirs.
4. Legacy compatibility: existing in-repo `.dao` state loads and persists
   byte-compatibly (no migration forced).
5. `initStorage` with github sync enabled selects `repo` mode.
