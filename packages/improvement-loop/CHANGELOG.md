# @guyghost/swarm-dao-improvement

## 0.6.3

### Patch Changes

- 76f8e01: Two governance/quality fixes from the dogfood series.

  **#141 — a gate failure no longer creates a final zombie.** A red-zone proposal checked without the mandatory dry-run dispatched `CONTROL_FAIL` into the final `failed` state: no re-check (even after completing the dry-run), no rejection, no annotation — only a duplicate proposal could move forward. Now `dao_control` refuses red-zone proposals without a completed dry-run _before_ any transition ("run dao_dry_run proposalId=N first; no state change was made — the proposal stays approved"), and `failed` is no longer lifecycle-final: it carries exactly one closure transition, `REJECT → rejected`, so even a dead proposal gets an auditable reason. `executed`/`rejected` remain the only final statuses.

  **#142 — optional metric contract.** `.dao/improvement.json` now accepts a `metric` section (`name` + `prompt`, optional `evidence`); when present, the sensor/counter-sensor prompts embed it verbatim so paired samples measure the same declared quantity across workers and cycles instead of each worker inventing its own "obvious" scope metric (which made arbitration decisions meaningless). A half-declared contract (name without prompt) fails config validation.

- c447a91: Grounding preflight and series-identity guards (issues #143, #144). Anchors now refuse to run on a dirty working tree: the grounding step checks `git status --porcelain` first and aborts with the offending path list, so worker debris or operator edits surface as a clear preflight error instead of false anchor failures and burned retries (non-git work directories keep the previous behavior). On the CLI side, `improve status/once/submit` fail with the resolved evidence-root path when the series does not exist there instead of answering from a phantom fresh idle snapshot, and `improve init` refuses an existing journal unless `--force` is passed — replay is never a clean slate, so a fresh series needs a new id while `--force` explicitly acknowledges resuming the recorded state.
- a43a2bd: Fail fast on concurrent improvement runners instead of corrupting journal.ndjson (issue #139): the series journal sequence lived only in the running process's memory, so two `improve once`/`improve submit` processes on the same series interleaved appends and produced a duplicate sequence — after which every command failed the sequence contract and the series was unreadable without manual repair. Every append now re-reads the journal tail first and aborts with a clear, recoverable `concurrent improvement runner detected` error when another writer advanced the file (nothing is written; re-running reloads the state). Also completes `improve` usage/error help with the cycle- and series-level human-gate subcommands (`retry`, `reference`, `cancel-cycle`, `retry-workers`, `restart`, `cancel`, `cycles`), which shipped in CLI 0.5.0 but were missing from the short usage string.
- Updated dependencies [76f8e01]
  - @guyghost/swarm-dao-core@0.16.2

## 0.6.2

### Patch Changes

- 9dd5891: Fix the `agent start` readiness race against herdr (`agent_pane_busy`). `herdr workspace create` returns before the fresh pane's shell has reached its interactive prompt, and `herdr agent start` classifies such a pane as busy instead of waiting — slower shell init under herd load (several agents working at once) made the failure intermittent and burned whole executor attempts (fresh workspace per retry, same race each time). `herdr agent start` is now retried on the SAME pane (1 s apart, via the new exported `startAgentUntilReady` helper) until the readiness budget (`startTimeoutMs`) is spent, in both the deliberation host adapter and the improvement-loop worker executor; any other herdr error code still fails immediately.
- 5fdc442: Read herdr's real `agent_status` lifecycle field when classifying settled agent states. herdr exposes `result.agent.agent_status`; the executors only read `agent.status`/`agent.state`, so the blocked-agent guard (approval/question UI) could never fire — a blocked worker was harvested as a confusing transcript error instead of the accurate "agent is blocked — it never produced a signal/vote" (issue #138). Applies to both the improvement-loop worker executor and the herdr deliberation host adapter; test fixtures now mirror the real herdr JSON contract.
- c393db4: Recover from `agent_prompt_stalled` instead of abandoning live workers. herdr's `agent prompt --wait` requires an observed state change within a hardcoded 5 s window; a fresh agent in a heavy repo under load can exceed it while the prompt was accepted and is being processed, and the executors treated the stall as a dead attempt — closing the workspace and retrying from scratch (issue #137, reproduced live: the agent answered while herdr reported `agent_prompt_stalled`). On stall, the new shared `promptAgentUntilSettled` helper grace-polls `agent get` (20 s default): if the agent came alive it waits for settle with `agent wait`; only a submission that stayed idle through the grace period is re-prompted, exactly once (a naive re-prompt risks double submission into a working agent).
- Updated dependencies [9dd5891]
- Updated dependencies [5fdc442]
- Updated dependencies [00c84a1]
- Updated dependencies [c393db4]
  - @guyghost/swarm-dao-herdr-adapter@0.4.2
  - @guyghost/swarm-dao-core@0.16.1

## 0.6.1

### Patch Changes

- Updated dependencies [5be1c48]
  - @guyghost/swarm-dao-core@0.16.0
  - @guyghost/swarm-dao-herdr-adapter@0.4.1

## 0.6.0

### Minor Changes

- e536a70: Security hardening for GitHub code scanning alerts (all 31 open alerts resolved).

  **Shell-command construction (12 alerts):** every adapter runner now spawns commands as ARGV via `execFile` — the JS side never builds a shell command line, so prompts, labels, series ids and paths can never be shell-interpreted. `HerdrRunner.exec`, `TmuxRunner.exec` and `SandboxExecRunner` take `argv: readonly string[]`; `buildSandboxCommand` (shell-string builder) is replaced by `buildSandboxArgv` (the anchored command still runs through `sh -c` inside the container, which belongs to the image, not to this process). The tmux pane program remains a deliberate shell program — operator-owned config, single argv element to tmux.

  **Polynomial ReDoS (15 alerts):** all risky regexes rewritten linear — line-oriented section parsing (vote/reasoning extraction, delegation signals, delivery-plan phases and tasks, RICE metrics) with `[ \t]` classes instead of `\s`, no `[\s\S]*?` lookahead alternations; trailing-run trims (`/\n+$/`, `/-+$/`, `/\/+$/`) replaced by linear scans. Behavior preserved, including the echo-shadowing case where the first `## Vote` section carries no vote word.

  **Workflow permissions (2 alerts):** `ci.yml` declares `permissions: contents: read`.

### Patch Changes

- Updated dependencies [e536a70]
  - @guyghost/swarm-dao-core@0.15.0
  - @guyghost/swarm-dao-herdr-adapter@0.4.0

## 0.5.6

### Patch Changes

- Updated dependencies [3f6f71d]
- Updated dependencies [89e2158]
  - @guyghost/swarm-dao-core@0.14.0
  - @guyghost/swarm-dao-herdr-adapter@0.3.0

## 0.5.5

### Patch Changes

- Updated dependencies [5ee6b0c]
- Updated dependencies [fd458db]
- Updated dependencies [b08481c]
  - @guyghost/swarm-dao-core@0.13.0
  - @guyghost/swarm-dao-herdr-adapter@0.2.7

## 0.5.4

### Patch Changes

- c13e6e5: Fix a ~1/36 flake in the worktree reuse test surfaced by dogfood cycle 8 (metric declined: 2 of 9 main-branch CI runs red).

  The `-b` (create-branch) assertion matched the raw git command string, so any mkdtemp suffix starting with "b" (`swarm-worktree-b…`) made the path contain "-b" and failed the branch-reuse expectation. The flag is now matched as an argument token.

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
