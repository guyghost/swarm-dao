# @guyghost/swarm-dao-pi-adapter

## 0.6.4

### Patch Changes

- Updated dependencies [1538199]
  - @guyghost/swarm-dao-core@0.12.0
  - @guyghost/swarm-dao-improvement@0.5.3
  - @guyghost/swarm-dao-graph@0.3.1
  - @guyghost/swarm-dao-product@0.3.1

## 0.6.3

### Patch Changes

- 91b26c4: Worktree and anchor hardening from dogfood-003 cycle 7 (all four anchors failed on a re-carved worktree):

  - A freshly carved series worktree now installs the frozen lockfile (`bun install --frozen-lockfile`) when it is a bun project, on create AND reuse (idempotent). Without it, anchor commands (`bun test`, `bun run`) fail on unresolved imports — c7 lost all four anchors to a missing `xstate`. Non-bun worktrees are skipped; a failed install surfaces through anchor outcome evidence instead of blocking the prepare.
  - ANCHOR_RECORDED evidence now joins every line (command + outcome tail) instead of keeping only the first — c7 snapshots recorded just the command, hiding the missing-dependency cause until it was reproduced by hand.
  - The Pi adapter tests no longer wipe the host repository's `.dao/` when run from a root-level `bun test`: they chdir into a throwaway git checkout (this exact wipe destroyed dogfood-003's worktree between cycles 6 and 7).

- Updated dependencies [91b26c4]
  - @guyghost/swarm-dao-improvement@0.5.2

## 0.6.2

### Patch Changes

- 326c1f4: Post-dogfood hardening (dogfood-003 cycle 6 findings):

  - Worker retries now close herdr workspaces left behind by a run killed mid-flight (host timeout, crash) before carving a fresh one — deterministic labels make lingering same-label workspaces orphans, so retries converge instead of accumulating panes.
  - `dao_improve_once` tool descriptions and the MCP README now state that worker phases take minutes and hosts must raise their request timeout (MCP clients default to 60s and kill the call mid-flight).

- Updated dependencies [326c1f4]
  - @guyghost/swarm-dao-improvement@0.5.1

## 0.6.1

### Patch Changes

- e073b9a: `advanceSeriesOnce` (and the `dao_improve_once` tools on MCP, Pi and OpenCode) accepts an optional cycle evidence root, mirroring the CLI's `--cycle-root`. Series that live under `evidence/improvement-series` can now keep their cycles under `evidence/improvement-cycles` instead of splitting across roots. The CLI test that polluted the repo's real evidence roots with a stray `nope` snapshot now uses a temp directory.
- Updated dependencies [e073b9a]
  - @guyghost/swarm-dao-improvement@0.5.0
  - @guyghost/swarm-dao-core@0.11.4

## 0.6.0

### Minor Changes

- 184216d: Expose `dao_improve_once` and the workflow-run surface to every AI host.

  - New `dao_improve_once` tool (MCP + Pi + OpenCode): advances a series by exactly one state-authorized effect through `advanceSeriesOnce` (new improvement export). The host supplies only the series id — the execution environment comes from the persisted `.dao/improvement.json` configuration and workers/anchors run inside the per-series worktree, so an AI host can pull the trigger but never aim it. Human-decision, worker-failed, halted and terminal states are no-ops.
  - Remaining hosts now expose the workflow-run surface: OpenCode gets `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status`, `dao_improve_once` natively; Claude gets generated `/dao:*` slash commands; Codex and Copilot receive the tools through the shared MCP server. The registry entries carry the full AI host set.

### Patch Changes

- Updated dependencies [184216d]
  - @guyghost/swarm-dao-improvement@0.4.0
  - @guyghost/swarm-dao-core@0.11.3

## 0.5.0

### Minor Changes

- 394fd06: Expose the workflow-run surface to AI hosts end to end.

  - New `dao_improve_status` tool (MCP + Pi): read-only improvement series snapshot — state, scope, cooldown, pending reason.
  - New Pi tools: `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status` (also reachable as `/dao` subcommands).
  - The graph and product packages now export AI-channel submission helpers (`submitAiGraphSignal`, `submitAiProductSignal`) that force `source: "ai"` and restrict event types at the type level; the MCP server uses them instead of building signals itself, so the authority boundary lives inside the packages rather than in host convention.

### Patch Changes

- Updated dependencies [394fd06]
  - @guyghost/swarm-dao-graph@0.3.0
  - @guyghost/swarm-dao-product@0.3.0
  - @guyghost/swarm-dao-core@0.11.2

## 0.4.1

### Patch Changes

- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0

## 0.4.0

### Minor Changes

- ee994e1: `/dao <subcommand>` now executes instead of routing: Pi slash commands cannot invoke Pi tools, but the adapter owns both surfaces, so every registry command (propose, deliberate, check, execute, ship, rollback, plan, artefacts, dry-run, roundtable, rate, update-proposal, check-edit, github-\*) now runs its tool logic inline and renders the result. Quote-aware argument parsing supports ids, titles, flags (`--cascade`, `--force`, `--token/owner/repo`, …) and usage messages on invalid input. Also fixes `dao_github_create_branch` / `dao_github_open_pr` reporting "GitHub not configured" immediately after a successful `dao_config_github` in the same session: the in-memory token is now reused when the persisted token is redacted and `DAO_GITHUB_TOKEN` is unset (same owner/repo only).

### Patch Changes

- Updated dependencies [ee994e1]
  - @guyghost/swarm-dao-core@0.10.1

## 0.3.6

### Patch Changes

- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0

## 0.3.5

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0

## 0.3.4

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0

## 0.3.3

### Patch Changes

- ad0cc86: Fix `/dao` commands silently doing nothing in Pi: command handlers returned a string, but Pi's real `registerCommand` contract is `Promise<void>` — the return value is discarded in every mode, so `/dao help`, `/dao status`, `/dao list`, etc. produced no visible output. Output is now rendered explicitly: interactive sessions get a focused bordered panel (Enter/Esc to close) via `ctx.ui.custom`; headless hosts (print mode) expose a `ui.custom` that resolves without ever invoking the component factory — detecting that signal selects a process-write fallback, the only channel those hosts leave visible (Pi's output guard redirects process writes to stderr to protect the stdout stream). Verified end-to-end against the real `pi` binary in print mode.
- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0

## 0.3.2

### Patch Changes

- 7a84b8d: Pi adapter audit — fixes and hardening. The `dao` slash command is now registered without a leading slash, matching Pi's `registerCommand` convention (the old `"/dao"` name was only invocable via `//dao`, since Pi strips one slash before lookup). The system prompt advertises exactly the 19 registered tools — the ghost `dao_verify` entry is gone and `dao_roundtable`, `dao_update_proposal`, `dao_check_edit`, and the GitHub tools are listed, with a drift test locking the list to actual registrations. `session_start` and `before_agent_start` survive a corrupt `state.json` (warn + minimal prompt instead of an extension error on every turn). `spawnAgents` honors `maxConcurrent` with batched fan-out instead of one unbounded `Promise.all`. `/dao` renders the same full dashboard as the `dao_dashboard` tool (pipeline + health metrics + score) and offers first-token subcommand completion via `getArgumentCompletions`. The `pi` subprocess escalates SIGTERM to SIGKILL after a 5 s grace period and caps combined output at 4 M chars.

## 0.3.1

### Patch Changes

- Updated dependencies [20a76a2]
  - @guyghost/swarm-dao-core@0.6.0

## 0.3.0

### Minor Changes

- 34fa76e: Wire the `mode` and `criticalPaths` configuration into a deterministic edit gate: `dao_check_edit` (exposed on MCP, Copilot/Claude/Codex adapters, Pi, and OpenCode) lets agents check the files they are about to touch before editing. `opt-in` flags critical paths informationally, `suggest` adds a non-blocking proposal nudge on uncovered critical paths, and `enforce` blocks critical paths unless an approved, controlled, or executed proposal declares them in `affectedPaths`. The gate is pure and read-only — it never edits files and never transitions proposal state. Previously `mode` and `criticalPaths` were documented as reserved schema with no host wiring.
- c561bb7: Expose the GitHub integration on the Pi extension and the OpenCode plugin: `dao_config_github`, `dao_github_create_branch`, and `dao_github_open_pr` are now registered as native tools on both hosts (previously CLI + MCP only). The registry entries list `pi` and `opencode`, and the three host-tool handlers now read state through the context repository instead of the process-global legacy bridge.

### Patch Changes

- Updated dependencies [1c20921]
- Updated dependencies [eb686bd]
- Updated dependencies [ecfa79a]
- Updated dependencies [831a124]
- Updated dependencies [ecd1d32]
- Updated dependencies [34fa76e]
- Updated dependencies [c561bb7]
  - @guyghost/swarm-dao-core@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [8b232e9]
- Updated dependencies [ed98280]
- Updated dependencies [7525259]
  - @guyghost/swarm-dao-core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [8e91a15]
  - @guyghost/swarm-dao-core@0.3.0

## 0.2.0

### Minor Changes

- Release 0.2.0 — model resolution, lifecycle hardening, security, and CI reliability.

  - Add XState state machine for proposal lifecycle management
  - Inherit model resolution when spawning DAO agents (agent override → parent session → DAO default → host default)
  - Harden security: secret redaction in config and logs, path traversal protection, sanitized persistence errors
  - Replace proposal type magic strings with typed constants
  - Add Husky pre-push hook and `bun run ci` script mirroring GitHub Actions
  - Pin Bun version in CI workflows and align publish workflow with lint gate
  - Update dependencies and documentation

### Patch Changes

- Updated dependencies
  - @guyghost/swarm-dao-core@0.2.0

## 0.1.4

### Patch Changes

- Patch release for recent improvements across the core package and adapters.
- Updated dependencies
  - @guyghost/swarm-dao-core@0.1.4

## 0.1.2

### Patch Changes

- Prepare a new patch release for all published Swarm DAO packages.
- Updated dependencies
  - @guyghost/swarm-dao-core@0.1.2

## 0.1.1

### Patch Changes

- 4574559: Prepare adapters for platform release

  - Improved type definitions with comprehensive JSDoc for the Pi adapter
  - Added complete README.md documentation for this package
  - Enhanced package.json metadata (keywords, sideEffects, peerDependenciesMeta)
  - Fixed type safety: narrowed `any` types to proper interfaces (Vote[], AmendmentPayload)
  - Fixed Pi hasCapability to not report spawn_agent as available when stubbed
  - Fixed Pi README installation instructions to avoid redundant dependencies
  - Added static import for addRating instead of dynamic import
  - Resolved ambient type leakage in Pi type stubs

- 66b061b: Initial release of Swarm DAO — unified AI agent governance with 4-layer architecture (Governance → Intelligence → Control → Delivery) and 7 default agents. Includes the Pi adapter and standalone CLI support.
- Updated dependencies [66b061b]
  - @guyghost/swarm-dao-core@0.1.1
