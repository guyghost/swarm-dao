# @guyghost/swarm-dao-improvement

## 0.5.3

### Patch Changes

- 1538199: Anchor results are immutable within the current attempt and refreshable across an authorized retry (Graph Engineering run `anchor-retry-refresh`, model hash 179b3a29, human-approved).

  - Machine (`recordAnchorOnce`): an anchor recorded at an earlier attempt is re-recorded when its command runs again at the current attempt; same-attempt duplicates stay rejected. A surviving anchor retained in a failed state no longer dead-ends every retry (dogfood-003 c7: an infra-failed `frozen-set-intact` survived each retry and could never be re-recorded).
  - Executor: grounding skips anchors already recorded at the current attempt (crash-resume idempotency — a re-entered grounding run no longer re-runs and throws on immutable results) and re-runs retained ones.
  - Model docs: `models/improvement-loop.md` anchor rules updated; the gap is closed in `improvement-loop.review.md`.
  - Repairs the `graph:*` and `product:*` CLI shims (re-export does not bind a local name for `import.meta.main`; `graph:init` had never run since the packages move).

- Updated dependencies [1538199]
  - @guyghost/swarm-dao-core@0.12.0
  - @guyghost/swarm-dao-herdr-adapter@0.2.6

## 0.5.2

### Patch Changes

- 91b26c4: Worktree and anchor hardening from dogfood-003 cycle 7 (all four anchors failed on a re-carved worktree):

  - A freshly carved series worktree now installs the frozen lockfile (`bun install --frozen-lockfile`) when it is a bun project, on create AND reuse (idempotent). Without it, anchor commands (`bun test`, `bun run`) fail on unresolved imports — c7 lost all four anchors to a missing `xstate`. Non-bun worktrees are skipped; a failed install surfaces through anchor outcome evidence instead of blocking the prepare.
  - ANCHOR_RECORDED evidence now joins every line (command + outcome tail) instead of keeping only the first — c7 snapshots recorded just the command, hiding the missing-dependency cause until it was reproduced by hand.
  - The Pi adapter tests no longer wipe the host repository's `.dao/` when run from a root-level `bun test`: they chdir into a throwaway git checkout (this exact wipe destroyed dogfood-003's worktree between cycles 6 and 7).

## 0.5.1

### Patch Changes

- 326c1f4: Post-dogfood hardening (dogfood-003 cycle 6 findings):

  - Worker retries now close herdr workspaces left behind by a run killed mid-flight (host timeout, crash) before carving a fresh one — deterministic labels make lingering same-label workspaces orphans, so retries converge instead of accumulating panes.
  - `dao_improve_once` tool descriptions and the MCP README now state that worker phases take minutes and hosts must raise their request timeout (MCP clients default to 60s and kill the call mid-flight).

## 0.5.0

### Minor Changes

- e073b9a: `advanceSeriesOnce` (and the `dao_improve_once` tools on MCP, Pi and OpenCode) accepts an optional cycle evidence root, mirroring the CLI's `--cycle-root`. Series that live under `evidence/improvement-series` can now keep their cycles under `evidence/improvement-cycles` instead of splitting across roots. The CLI test that polluted the repo's real evidence roots with a stray `nope` snapshot now uses a temp directory.

### Patch Changes

- Updated dependencies [e073b9a]
  - @guyghost/swarm-dao-core@0.11.4

## 0.4.0

### Minor Changes

- 184216d: Expose `dao_improve_once` and the workflow-run surface to every AI host.

  - New `dao_improve_once` tool (MCP + Pi + OpenCode): advances a series by exactly one state-authorized effect through `advanceSeriesOnce` (new improvement export). The host supplies only the series id — the execution environment comes from the persisted `.dao/improvement.json` configuration and workers/anchors run inside the per-series worktree, so an AI host can pull the trigger but never aim it. Human-decision, worker-failed, halted and terminal states are no-ops.
  - Remaining hosts now expose the workflow-run surface: OpenCode gets `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status`, `dao_improve_once` natively; Claude gets generated `/dao:*` slash commands; Codex and Copilot receive the tools through the shared MCP server. The registry entries carry the full AI host set.

### Patch Changes

- Updated dependencies [184216d]
  - @guyghost/swarm-dao-core@0.11.3

## 0.3.1

### Patch Changes

- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0
  - @guyghost/swarm-dao-herdr-adapter@0.2.5

## 0.3.0

### Minor Changes

- 1b210ea: Add worktree execution environments and configurable herdr worker agents.

  - `ensureSeriesWorktree`: idempotent per-series git worktree (branch `dao/loop/<series-id>`, path `.dao/worktrees/<series-id>`), re-syncing the gitignored `.dao/improvement.json` into the worktree on every prepare.
  - `OrchestratorOnceDeps.worker` threads the herdr agent kind and extra args to the default worker executor; only `pi` defaults to `-ne`, other kinds (codex, claude, …) start with their own defaults. `SAFE_HERDR_KIND` is exported for host validation.

### Patch Changes

- Updated dependencies [dfb8fd5]
  - @guyghost/swarm-dao-core@0.10.2

## 0.2.2

### Patch Changes

- 2e1a24d: Realign npm publishing after the 0.2.1 collision: the first CI publish (0.2.0) failed with E404 because npm Trusted Publishing cannot create a new package, and 0.2.1 was published manually while configuring the Trusted Publisher — colliding with the automated Version Packages release. This patch lets CI publish 0.2.2 and exercises the OIDC trusted-publisher path end-to-end for this package.

## 0.2.1

### Patch Changes

- 82df3ed: ADR-003 accepted: sandboxed proposal execution. `planExecutionIsolation` and `createExecutionWorkspace` accept `execution.isolation: "sandbox"` (worktree + bounded container: runtime probed before provisioning, network disabled, CPU/memory capped, image strictly validated) next to `worktree`; the pure container command builder moves to core delivery (`buildSandboxCommand`, `validateSandboxImage`) and the improvement package reuses it. Env-gated integration test (`EVOLUTION_IT=1`) proves a trivial evolution lands in the sandboxed worktree.
- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0
  - @guyghost/swarm-dao-herdr-adapter@0.2.4

## 0.2.0

### Minor Changes

- 08a8b29: Improvement loop everywhere: new `@guyghost/swarm-dao-improvement` executor package (series orchestrator, cycle runner, herdr workers, per-project `.dao/improvement.json` anchor config) and `swarm-dao improve init|status|once|submit` CLI commands to run improvement series in any project. Anchor commands can execute in a bounded sandbox (`--sandbox docker|container|auto|none --image <ref>`: network off, repo mounted at /workspace, CPU/memory caps) via Docker or Apple container. Core gains the `models/improvement` export subpath and the `improve` registry entry.

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0
  - @guyghost/swarm-dao-herdr-adapter@0.2.3
