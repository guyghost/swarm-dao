# @guyghost/swarm-dao-tmux-adapter

## 0.4.3

### Patch Changes

- Updated dependencies [28d24ca]
- Updated dependencies [4443f1a]
- Updated dependencies [2b03f27]
- Updated dependencies [ec03c6f]
- Updated dependencies [e7ef6a2]
- Updated dependencies [4aa7b9c]
- Updated dependencies [f38bea6]
- Updated dependencies [2f510a9]
- Updated dependencies [c3cf299]
  - @guyghost/swarm-dao-core@3.0.0

## 0.4.2

### Patch Changes

- Updated dependencies [b7f55eb]
- Updated dependencies [c20ef3d]
- Updated dependencies [e256fbc]
- Updated dependencies [fd1e0d1]
  - @guyghost/swarm-dao-core@2.0.0

## 0.4.1

### Patch Changes

- 4184177: Fix published manifests: internal dependencies were declared with the `workspace:*` protocol, which `npm publish` does not resolve (only pnpm does). Every install of the affected packages failed with `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`. Restore `^` semver ranges, which changesets bumps automatically on release.
- Updated dependencies [527195a]
  - @guyghost/swarm-dao-core@1.0.1

## 0.4.0

### Minor Changes

- 2da3218: Agent runtime configuration: per-agent LLM model and harness (pi, claude, codex, copilot, opencode).

  - Core: `runtime.defaultHarness` / `runtime.harnessModelFlag` project config, `harness` agent frontmatter, deterministic resolution (D1: agent → project → host default), typed E1–E5 failures surfaced per-agent instead of throwing. Runtime resolution activates only when a signal exists — hosts that never opted in keep the legacy dispatch.
  - Adapters: herdr spawns `harness <kind> -- <args> --model <model>`; tmux supports per-agent `agentCommands`; pi enforces the host boundary (only "pi" harness); opencode/mcp declare their host default.
  - CLI: `dao child` gains `--harness-model-flag`, tmux `agentCommands`, and the kind fallback chain `--kind` → `herdr.kind` → `runtime.defaultHarness` → `pi`.

- 72ad3ed: Governance integrity hardening (issues #153–#169).

  - Core: revision-based optimistic concurrency (stateRevision) — a stale writer now fails persist() instead of silently dropping votes; both load paths repair ID counters; corrupt state.json gets a clear error plus an automatic backup before shape repair; token-owned lock files with heartbeat; atomic writes for contained files and the GitHub config; updateStorageSettings runs under the DAO lock; ship-audit claim locks are reclaimable when their owner is gone.
  - Core: tallyVotes grounds the quorum denominator in the configured council (silent members carry their configured weight), never undercuts the votes cast, and compares thresholds as exact fractions — Math.round no longer decides approvals.
  - Core: addVote replaces the same agent's prior vote, refuses votes outside open/deliberating and bounds weight (config.maxVoteWeight, default 3).
  - Core: proposal machine guards recompute the tally and replay the gates instead of trusting the event payload; guarded events require config.
  - Core: deliberation rollback on worker failure (ERROR + persist + audit) and a new ABORT_DELIBERATION transition (deliberating → open); deliberationStartedAt recorded.
  - Core: delegation-closed gate consults a persisted cross-process in-flight marker, so INV-8 can actually block.
  - Core: risk-threshold gate fails closed when no risk scores were produced; control failures transition failed by default (failOnGateFailure opt-out); dependency cycles rejected at creation; dependency-readiness uses transitive closure; cascade ship reports its shipped prefix on failure.
  - Core: GitHub owner/repo/headBranch validated before persistence and before any gh api call.
  - MCP: declared input schemas are enforced at runtime via a single schema registry (no more NaN ids, unbounded scores or forged event enums).
  - herdr: contained path resolution returns the resolved path (TOCTOU symlink escape closed).
  - CLI/tmux/herdr: HostAdapter.exec routes through the core's shell-free execCommand.

### Patch Changes

- 96cf36b: Enforce type-specific vote thresholds, contain evidence roots, fail closed on Pi spawn fallback, and lock cycle journals against concurrent writers.
- Updated dependencies [2da3218]
- Updated dependencies [96cf36b]
- Updated dependencies [f8d6167]
- Updated dependencies [9eee0bf]
- Updated dependencies [6487091]
- Updated dependencies [0a96294]
- Updated dependencies [f8d6167]
- Updated dependencies [72ad3ed]
  - @guyghost/swarm-dao-core@1.0.0

## 0.3.1

### Patch Changes

- Updated dependencies [5be1c48]
  - @guyghost/swarm-dao-core@0.16.0

## 0.3.0

### Minor Changes

- e536a70: Security hardening for GitHub code scanning alerts (all 31 open alerts resolved).

  **Shell-command construction (12 alerts):** every adapter runner now spawns commands as ARGV via `execFile` — the JS side never builds a shell command line, so prompts, labels, series ids and paths can never be shell-interpreted. `HerdrRunner.exec`, `TmuxRunner.exec` and `SandboxExecRunner` take `argv: readonly string[]`; `buildSandboxCommand` (shell-string builder) is replaced by `buildSandboxArgv` (the anchored command still runs through `sh -c` inside the container, which belongs to the image, not to this process). The tmux pane program remains a deliberate shell program — operator-owned config, single argv element to tmux.

  **Polynomial ReDoS (15 alerts):** all risky regexes rewritten linear — line-oriented section parsing (vote/reasoning extraction, delegation signals, delivery-plan phases and tasks, RICE metrics) with `[ \t]` classes instead of `\s`, no `[\s\S]*?` lookahead alternations; trailing-run trims (`/\n+$/`, `/-+$/`, `/\/+$/`) replaced by linear scans. Behavior preserved, including the echo-shadowing case where the first `## Vote` section carries no vote word.

  **Workflow permissions (2 alerts):** `ci.yml` declares `permissions: contents: read`.

### Patch Changes

- Updated dependencies [e536a70]
  - @guyghost/swarm-dao-core@0.15.0

## 0.2.8

### Patch Changes

- Updated dependencies [3f6f71d]
- Updated dependencies [89e2158]
  - @guyghost/swarm-dao-core@0.14.0

## 0.2.7

### Patch Changes

- Updated dependencies [5ee6b0c]
- Updated dependencies [fd458db]
- Updated dependencies [b08481c]
  - @guyghost/swarm-dao-core@0.13.0

## 0.2.6

### Patch Changes

- Updated dependencies [1538199]
  - @guyghost/swarm-dao-core@0.12.0

## 0.2.5

### Patch Changes

- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0

## 0.2.4

### Patch Changes

- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0

## 0.2.3

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0

## 0.2.2

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0

## 0.2.1

### Patch Changes

- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0

## 0.2.0

### Minor Changes

- 3113589: New tmux host: `createTmuxHostAdapter` runs each deliberation agent as its own detached tmux pane (the swarm-forge execution model) — watchable live via `tmux attach`, with prompt/output/completion markers under `.dao/tmux/<proposalId>/<agentId>/`. The agent command runs as the session program (no pane-shell typing race), stale completion markers are purged per run, timeouts kill the session with a deterministic error output, and `keepSessions` preserves pane scrollback for inspection. Outputs feed the same deterministic tally as every other host. Configured via `tmux.command` (`$PROMPT` carries the deliberation prompt) in `.dao/config.json`.
