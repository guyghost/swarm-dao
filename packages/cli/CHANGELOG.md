# @guyghost/swarm-dao-cli

## 0.13.1

### Patch Changes

- Updated dependencies [b7f55eb]
- Updated dependencies [c20ef3d]
- Updated dependencies [e256fbc]
- Updated dependencies [fd1e0d1]
  - @guyghost/swarm-dao-core@2.0.0
  - @guyghost/swarm-dao-graph@0.4.1
  - @guyghost/swarm-dao-herdr-adapter@0.5.2
  - @guyghost/swarm-dao-improvement@0.6.9
  - @guyghost/swarm-dao-product@0.3.8
  - @guyghost/swarm-dao-tmux-adapter@0.4.2

## 0.13.0

### Minor Changes

- d722194: CLI: new `rate <id> --score <1-5> --comment <text> [--by <name>]` command so
  headless pipelines can record post-execution outcome ratings without going
  through the MCP `dao_rate` tool. It reuses `RateProposalUseCase` (executed
  status gate, 1–5 score validation), records an `outcome-rated` audit entry
  with the rater, and prints the recomputed overall score. The `rate` registry
  command is now exposed to the `cli` host.
- d0c794c: Surface shipped-but-unrated proposals so the retro loop actually gets closed:
  
  - `swarm-dao list --unrated` — executed proposals with no outcome rating,
    with a `close the loop: swarm-dao rate <id> ...` hint.
  - `swarm-dao next` (and `watch`) gains a read-only "Retro loop" section
    listing shipped-but-unrated proposals with the exact rating command. It is
    fully silent in projects without a DAO and never creates `.dao/` as a side
    effect.
  
  Closes the discovery gap left after the `rate` command (#190/#192): ratings
  no longer stay pending invisibly.

### Patch Changes

- 6b7d790: Graph Engineering retries after failed evaluation are now system-owned: EVALUATE / IMPLEMENTATION_FAILED with remaining budget auto-continue to implementing. There is no RETRY_AUTHORIZED human event on a graph run; model-hash approval and cancel stay human.
- 9cc48a9: Wire the classifier verdict into Graph Engineering implementing: the host prepends CLASSIFIER_CHARTER, routes on evaluateAttempt, and only then emits IMPLEMENTATION_READY or IMPLEMENTATION_FAILED.
- Updated dependencies [3aa2664]
- Updated dependencies [d722194]
- Updated dependencies [6b7d790]
- Updated dependencies [9cc48a9]
  - @guyghost/swarm-dao-core@1.1.0
  - @guyghost/swarm-dao-graph@0.4.0

## 0.12.2

### Patch Changes

- e0aa07f: Stop the harvest stable-poll killing workers that run long uncached commands (issue #180): four identical polls (≈20 s of transcript silence) misread a worker mid-command — e.g. a drift auditor re-running an uncached full test suite — as "settled without a valid contract", failing all 3 attempts. The stable-settle window is now `DEFAULT_STABLE_POLLS` (36 ≈ 3 min at the default 5 s poll) and the default attempt deadline rose to the 15 min ceiling; both are tunable via the new `worker.stablePolls` / `worker.pollIntervalMs` / `worker.timeoutMs` fields of `.dao/improvement.json` (non-numeric values are refused, out-of-range numbers clamped). Cost when an agent genuinely settles with prose: the stable window per attempt.
- Updated dependencies [e0aa07f]
  - @guyghost/swarm-dao-improvement@0.6.8

## 0.12.1

### Patch Changes

- 4184177: Fix published manifests: internal dependencies were declared with the `workspace:*` protocol, which `npm publish` does not resolve (only pnpm does). Every install of the affected packages failed with `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`. Restore `^` semver ranges, which changesets bumps automatically on release.
- 527195a: Close vote-tally poisoning (charter placeholders, fenced decoys, delegated-child hijack), apply council weights on the CLI, add `swarm-dao control`, and fail-close unknown gates / cascade+force / shell-free improvement anchors.
- Updated dependencies [4184177]
- Updated dependencies [527195a]
  - @guyghost/swarm-dao-graph@0.3.7
  - @guyghost/swarm-dao-improvement@0.6.7
  - @guyghost/swarm-dao-product@0.3.7
  - @guyghost/swarm-dao-herdr-adapter@0.5.1
  - @guyghost/swarm-dao-tmux-adapter@0.4.1
  - @guyghost/swarm-dao-core@1.0.1

## 0.12.0

### Minor Changes

- 2da3218: Agent runtime configuration: per-agent LLM model and harness (pi, claude, codex, copilot, opencode).

  - Core: `runtime.defaultHarness` / `runtime.harnessModelFlag` project config, `harness` agent frontmatter, deterministic resolution (D1: agent → project → host default), typed E1–E5 failures surfaced per-agent instead of throwing. Runtime resolution activates only when a signal exists — hosts that never opted in keep the legacy dispatch.
  - Adapters: herdr spawns `harness <kind> -- <args> --model <model>`; tmux supports per-agent `agentCommands`; pi enforces the host boundary (only "pi" harness); opencode/mcp declare their host default.
  - CLI: `dao child` gains `--harness-model-flag`, tmux `agentCommands`, and the kind fallback chain `--kind` → `herdr.kind` → `runtime.defaultHarness` → `pi`.

### Patch Changes

- 2f88aa9: doctor: validate .dao/config.json strictly (await loadConfig on the real dao root). Invalid config is a failing check with the fix hint; enforce-without-criticalPaths is a warning. Previously the check was un-awaited, pointed at the wrong path, and swallowed errors.
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

- Updated dependencies [2da3218]
- Updated dependencies [96cf36b]
- Updated dependencies [f8d6167]
- Updated dependencies [9eee0bf]
- Updated dependencies [6487091]
- Updated dependencies [0a96294]
- Updated dependencies [f8d6167]
- Updated dependencies [72ad3ed]
  - @guyghost/swarm-dao-core@1.0.0
  - @guyghost/swarm-dao-tmux-adapter@0.4.0
  - @guyghost/swarm-dao-herdr-adapter@0.5.0
  - @guyghost/swarm-dao-graph@0.3.6
  - @guyghost/swarm-dao-improvement@0.6.6
  - @guyghost/swarm-dao-product@0.3.6

## 0.11.1

### Patch Changes

- c447a91: Grounding preflight and series-identity guards (issues #143, #144). Anchors now refuse to run on a dirty working tree: the grounding step checks `git status --porcelain` first and aborts with the offending path list, so worker debris or operator edits surface as a clear preflight error instead of false anchor failures and burned retries (non-git work directories keep the previous behavior). On the CLI side, `improve status/once/submit` fail with the resolved evidence-root path when the series does not exist there instead of answering from a phantom fresh idle snapshot, and `improve init` refuses an existing journal unless `--force` is passed — replay is never a clean slate, so a fresh series needs a new id while `--force` explicitly acknowledges resuming the recorded state.
- a43a2bd: Fail fast on concurrent improvement runners instead of corrupting journal.ndjson (issue #139): the series journal sequence lived only in the running process's memory, so two `improve once`/`improve submit` processes on the same series interleaved appends and produced a duplicate sequence — after which every command failed the sequence contract and the series was unreadable without manual repair. Every append now re-reads the journal tail first and aborts with a clear, recoverable `concurrent improvement runner detected` error when another writer advanced the file (nothing is written; re-running reloads the state). Also completes `improve` usage/error help with the cycle- and series-level human-gate subcommands (`retry`, `reference`, `cancel-cycle`, `retry-workers`, `restart`, `cancel`, `cycles`), which shipped in CLI 0.5.0 but were missing from the short usage string.
- Updated dependencies [76f8e01]
- Updated dependencies [c447a91]
- Updated dependencies [a43a2bd]
  - @guyghost/swarm-dao-core@0.16.2
  - @guyghost/swarm-dao-improvement@0.6.3

## 0.11.0

### Minor Changes

- 5be1c48: The CLI detects the terminal multiplexer it runs inside and behaves accordingly. `HERDR_ENV=1` → herdr parent session, `TMUX` → tmux parent session, bare shell → herdr default. The multi-agent flows (`deliberate`, `roundtable`, `implement`) resolve their child-session host via a new `--host <herdr|tmux|auto>` flag (`auto` follows detection): inside tmux the children become tmux sessions running the operator-owned `tmux.command` from a new typed `tmux` section of `.dao/config.json` (fail-fast with setup guidance when unset), and the attach hint matches the host (`herdr` / `tmux attach -t <session>`). Child names are previewed with the exact names each host creates.

### Patch Changes

- Updated dependencies [5be1c48]
  - @guyghost/swarm-dao-core@0.16.0
  - @guyghost/swarm-dao-graph@0.3.5
  - @guyghost/swarm-dao-herdr-adapter@0.4.1
  - @guyghost/swarm-dao-improvement@0.6.1
  - @guyghost/swarm-dao-product@0.3.5
  - @guyghost/swarm-dao-tmux-adapter@0.3.1

## 0.10.0

### Minor Changes

- e536a70: Security hardening for GitHub code scanning alerts (all 31 open alerts resolved).

  **Shell-command construction (12 alerts):** every adapter runner now spawns commands as ARGV via `execFile` — the JS side never builds a shell command line, so prompts, labels, series ids and paths can never be shell-interpreted. `HerdrRunner.exec`, `TmuxRunner.exec` and `SandboxExecRunner` take `argv: readonly string[]`; `buildSandboxCommand` (shell-string builder) is replaced by `buildSandboxArgv` (the anchored command still runs through `sh -c` inside the container, which belongs to the image, not to this process). The tmux pane program remains a deliberate shell program — operator-owned config, single argv element to tmux.

  **Polynomial ReDoS (15 alerts):** all risky regexes rewritten linear — line-oriented section parsing (vote/reasoning extraction, delegation signals, delivery-plan phases and tasks, RICE metrics) with `[ \t]` classes instead of `\s`, no `[\s\S]*?` lookahead alternations; trailing-run trims (`/\n+$/`, `/-+$/`, `/\/+$/`) replaced by linear scans. Behavior preserved, including the echo-shadowing case where the first `## Vote` section carries no vote word.

  **Workflow permissions (2 alerts):** `ci.yml` declares `permissions: contents: read`.

### Patch Changes

- Updated dependencies [e536a70]
  - @guyghost/swarm-dao-core@0.15.0
  - @guyghost/swarm-dao-herdr-adapter@0.4.0
  - @guyghost/swarm-dao-improvement@0.6.0
  - @guyghost/swarm-dao-graph@0.3.4
  - @guyghost/swarm-dao-product@0.3.4

## 0.9.0

### Minor Changes

- 3f6f71d: herdr child sessions by default for every multi-agent CLI flow. The new `swarm-dao deliberate <id>` makes every agent vote as a real coding agent in its own herdr child session, `swarm-dao roundtable` does the same for proposal ideas, and `swarm-dao implement <id> [<id>…]` dispatches one herdr child agent per proposal — multiple ids develop in parallel, each in its own execution worktree (requires `execution.isolation`). The CLI process is the parent session that pilots the children; attach with `herdr` to watch any child live. Kind and harvest options default from a new typed `herdr` section in `.dao/config.json` (`kind`, `keepPanes`, `timeoutMs`), overridable via `--kind`, `--keep-panes`, `--timeout-ms`. Also exports `herdrAgentName` from the herdr adapter and widens `ExecutionConfig.isolation` to include `"sandbox"` (already supported by GitWorkspace).

### Patch Changes

- Updated dependencies [3f6f71d]
- Updated dependencies [89e2158]
  - @guyghost/swarm-dao-core@0.14.0
  - @guyghost/swarm-dao-herdr-adapter@0.3.0
  - @guyghost/swarm-dao-graph@0.3.3
  - @guyghost/swarm-dao-improvement@0.5.6
  - @guyghost/swarm-dao-product@0.3.3

## 0.8.0

### Minor Changes

- 5ee6b0c: GitHub auth via the `gh` CLI; auditable rejection path; vote preservation; shared project brief.

  - **Breaking (config):** GitHub authentication is delegated to the `gh` CLI — run `gh auth login` once. `dao_config_github` / `swarm-dao github-config` no longer take a `--token`; they store `owner`, `repo` and an `issues` opt-in (track proposal modifications as GitHub issues). `DAO_GITHUB_TOKEN` is no longer read.
  - **New:** `dao_reject` tool and `swarm-dao reject-proposal <id> --reason <text>` — auditable human REJECT/DISCARD for open, deliberating and approved proposals.
  - **Fix:** deliberation merges votes instead of replacing them — human/CLI votes survive, and agents without a `## Vote` section no longer produce fabricated abstentions.
  - **New:** a deterministic project brief (manifest, README, layout, changelog) is built once per deliberation/round table and injected into every participant's prompt.

- fd458db: Agents no longer hardcode a model.

  - Removed `model: z.ai/GLM-5.1` from every agent description (`agents/dao-*.md`, `packages/copilot-adapter/agents/*.agent.md`) and dropped the `DEFAULT_AGENT_MODEL` stamp.
  - The model now resolves at dispatch time: agent override (frontmatter `model`) → DAO config default (`DAOConfig.defaultModel`, overridable in `.dao/config.json`) → parent session / host default. Agents without an explicit model inherit the session's model on hosts that support it.

- b08481c: Agent roster grows to 8 with SwarmForge-style role definitions.

  - All seven default agent prompts rewritten in an owns / review-method / rules / does-not-own structure (inspired by unclebob/swarm-forge roles): sharper ownership boundaries, structured review phases, and evidence rules per role.
  - **New default agent: UX/UI Designer** (`designer`, weight 2) — UX/UI critique and improvement directions across the four surface modes (Persuade / Operate / Read / Experience), accessibility review (WCAG AA as defects), and design-direction output. Uses the impeccable harness lenses (impeccable.style) when the host provides it, and the Mobbin MCP server as optional design-reference material (requires a subscription).
  - Per-agent tooling declarations: `tools` frontmatter field in `dao-*.md` is now parsed; the Architect declares `sequential-thinking` (structured step-by-step review), Delivery declares `context7` (library API verification), Designer declares `impeccable` + `mobbin`. Agents degrade gracefully when a tool is not configured by the host.
  - `dao_setup` now seeds 8 agents (new DAOs only; existing DAO state is unchanged).

### Patch Changes

- Updated dependencies [5ee6b0c]
- Updated dependencies [fd458db]
- Updated dependencies [b08481c]
  - @guyghost/swarm-dao-core@0.13.0
  - @guyghost/swarm-dao-graph@0.3.2
  - @guyghost/swarm-dao-improvement@0.5.5
  - @guyghost/swarm-dao-product@0.3.2

## 0.7.1

### Patch Changes

- a9c0f81: Homebrew distribution via `guyghost/tap` and Node-first shebang.

  - Switched the CLI shebang from `#!/usr/bin/env bun` to `#!/usr/bin/env node` — the compiled output uses no Bun-specific APIs, so the CLI now runs on plain Node ≥ 20 (still fully Bun-compatible).
  - The CLI is now installable from Homebrew: `brew install guyghost/tap/swarm-dao` (tap auto-syncs to npm releases after Homebrew's 24h security cooldown).

## 0.7.0

### Minor Changes

- e53c8b0: `watch` live pane and `improve cancel-cycle`.

  - `watch [--interval <s>] [--once]`: one screen refreshed live — pending human gates with runnable commands, cooldown countdowns, in-flight runs. Ctrl-C exits cleanly; `--once` renders a single frame for scripts and non-TTY contexts.
  - `improve cancel-cycle --cycle-id <id> --reason <text>`: terminal human gate for standalone cycles (CANCEL), completing the gate command set.

## 0.6.0

### Minor Changes

- 0ffcef6: CLI onboarding and guidance (UX lot 3).

  - `doctor`: one-command diagnostic — runtime, git, herdr worker agents, docker sandbox, DAO storage, improvement config, evidence roots, pending human gates — each green/yellow/red with the fix; exits 1 when a gate is pending.
  - Per-command help: `swarm-dao <command> --help` prints that command's usage (exit 0) instead of falling into an error.
  - Next-step hints: `propose`, `vote`, and `improve init` end with the exact follow-up command (dimmed `→ next:` line).

## 0.5.0

### Minor Changes

- 97083c0: CLI operator experience: human gates get dedicated commands, status becomes human-readable.

  - New gate commands replace hand-written JSON signal files (each shows the exact decision inputs and requires confirmation; `--yes` for reviewed non-interactive use): `approve`/`reject` (graph MODEL_APPROVED/MODEL_REJECTED with the exact model hash), `improve retry` (RETRY_AUTHORIZED), `improve retry-workers`, `improve restart`, `improve cancel --reason`, `improve reference --decision approve|reject` (adjusting cycles).
  - `improve status` and `graph status` render human-readable output by default (state glyphs, hashes, anchors, suggested next command); `--json` keeps the raw machine snapshot.
  - `improve cycles --series-id` lists the cycle history (outcome, attempt, metric, drift, arbitration, duration from the journal).
  - `next` shows what the machines need from you now: pending human gates with runnable commands, plus live workflows (cooldown countdowns, in-flight runs).
  - Evidence roots resolve across `.dao/*` and `evidence/*` for reads (a started series beats a stale idle snapshot materialized by an unrooted `improve status`), killing silent `idle` answers; creation effects keep the strict root.
  - Attention suggestions now point at the new gate commands.

### Patch Changes

- Updated dependencies [97083c0]
  - @guyghost/swarm-dao-core@0.12.1

## 0.4.5

### Patch Changes

- Updated dependencies [1538199]
  - @guyghost/swarm-dao-core@0.12.0
  - @guyghost/swarm-dao-improvement@0.5.3
  - @guyghost/swarm-dao-graph@0.3.1
  - @guyghost/swarm-dao-product@0.3.1

## 0.4.4

### Patch Changes

- Updated dependencies [e073b9a]
  - @guyghost/swarm-dao-improvement@0.5.0
  - @guyghost/swarm-dao-core@0.11.4

## 0.4.3

### Patch Changes

- Updated dependencies [184216d]
  - @guyghost/swarm-dao-improvement@0.4.0
  - @guyghost/swarm-dao-core@0.11.3

## 0.4.2

### Patch Changes

- Updated dependencies [394fd06]
  - @guyghost/swarm-dao-graph@0.3.0
  - @guyghost/swarm-dao-product@0.3.0
  - @guyghost/swarm-dao-core@0.11.2

## 0.4.1

### Patch Changes

- 1e33d15: `swarm-dao attention` gains an `improvement-series` source: series parked in `workerFailed` (RETRY_WORKERS pending) or `halted` (RESTART_SERIES / CANCEL_SERIES pending) now surface with the pending reason and a runnable `swarm-dao improve submit --series-id …` suggestion. Series evidence is swept from `evidence/improvement-series` and `.dao/improvement-series`. `awaitingHumanCycleDecision` is deliberately not a series gate — the human decision lives on the cycle and is already surfaced by the `improvement-loop` source.
- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0
  - @guyghost/swarm-dao-graph@0.2.1
  - @guyghost/swarm-dao-improvement@0.3.1
  - @guyghost/swarm-dao-product@0.2.1

## 0.4.0

### Minor Changes

- 1b210ea: `improve once` gains `--exec branch|worktree|container` (where the series runs: current checkout, an isolated per-series git worktree, or anchor commands in a bounded container) and `--agent <kind>` / `--agent-args` (which herdr agent executable runs the workers — pi, codex, claude, …; also configurable via `worker` in `.dao/improvement.json`).
- aaa716e: Add `swarm-dao graph <init|status|submit>` — Graph Engineering change-control runs in any project (evidence under `.dao/graph-runs` by default), alongside the existing `improve` loop commands.
- 90ba1f4: Add `swarm-dao product <init|status|submit>` — product-loop runs in any project (evidence under `.dao/product-loops` by default), completing the CLI trio: DAO proposals, Graph Engineering runs, product loops, and improvement series.

### Patch Changes

- Updated dependencies [dfb8fd5]
- Updated dependencies [aaa716e]
- Updated dependencies [1b210ea]
- Updated dependencies [90ba1f4]
  - @guyghost/swarm-dao-core@0.10.2
  - @guyghost/swarm-dao-graph@0.2.0
  - @guyghost/swarm-dao-improvement@0.3.0
  - @guyghost/swarm-dao-product@0.2.0

## 0.3.1

### Patch Changes

- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0
  - @guyghost/swarm-dao-improvement@0.2.1

## 0.3.0

### Minor Changes

- 08a8b29: Improvement loop everywhere: new `@guyghost/swarm-dao-improvement` executor package (series orchestrator, cycle runner, herdr workers, per-project `.dao/improvement.json` anchor config) and `swarm-dao improve init|status|once|submit` CLI commands to run improvement series in any project. Anchor commands can execute in a bounded sandbox (`--sandbox docker|container|auto|none --image <ref>`: network off, repo mounted at /workspace, CPU/memory caps) via Docker or Apple container. Core gains the `models/improvement` export subpath and the `improve` registry entry.

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0
  - @guyghost/swarm-dao-improvement@0.2.0

## 0.2.6

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0

## 0.2.4

### Patch Changes

- 20a76a2: Add the opt-in ship audit challenge (swarm-forge's AUDIT_REQUIRED adapted to shipping): with `ship.auditChallenge: true` in `.dao/config.json`, the first `dao_ship`/`swarm-dao ship` call returns `AUDIT_REQUIRED` instead of executing; only an unchanged second call executes, bound to a deterministic fingerprint of the decision content (votes, gates, scope). Any change re-issues the challenge; a confirmation is single-use (spent on one execution attempt); `--force` is an explicit, recorded human bypass. Pure `ship-audit.machine.ts` (no AI role — confirmation is a deterministic property of two identical requests), an `FsShipAuditStore` under `.dao/ship-audits/`, wired into the host ship handler and the CLI. Gated through the Graph Engineering change-control ceremony (run `ship-audit-1`, model hash approved by the owner). Anchors: `shipaudit:validate`, `shipaudit:demo`, `shipaudit:regression`.
- Updated dependencies [20a76a2]
  - @guyghost/swarm-dao-core@0.6.0

## 0.2.3

### Patch Changes

- ecfa79a: Add opt-in execution isolation via git worktrees. When `execution.isolation` is `"worktree"` in `.dao/config.json`, executing a proposal first provisions a dedicated worktree (branch `dao/<id>-<slug>` under `.dao/worktrees`), the execution snapshot and audit record the real branch, and merging back stays a separate deliberate action. Includes: pure `planExecutionIsolation`, an `ExecutionWorkspacePort` injected into ExecuteProposalUseCase/ShipProposalUseCase, a `GitWorkspace` adapter (idempotent retry, branch-exists fallback) wired into `dao_execute` on every host and `swarm-dao ship` on the CLI. A failed preparation leaves the proposal `controlled`.
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

- 66b061b: Initial release of Swarm DAO — unified AI agent governance with 4-layer architecture (Governance → Intelligence → Control → Delivery) and 7 default agents. Includes Pi adapter, OpenCode adapter, and standalone CLI.
- Updated dependencies [66b061b]
  - @guyghost/swarm-dao-core@0.1.1
