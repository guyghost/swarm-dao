# @guyghost/swarm-dao-herdr-adapter

## 0.5.3

### Patch Changes

- f38bea6: Honour an explicit timeout instead of silently clamping it to 300s: the
  5-minute ceiling now guards only the default, so a `--timeout-ms` the operator
  asked for (e.g. 10 minutes) is passed through. A missing or invalid value still
  falls back to the default.
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

## 0.5.2

### Patch Changes

- Updated dependencies [b7f55eb]
- Updated dependencies [c20ef3d]
- Updated dependencies [e256fbc]
- Updated dependencies [fd1e0d1]
  - @guyghost/swarm-dao-core@2.0.0

## 0.5.1

### Patch Changes

- 4184177: Fix published manifests: internal dependencies were declared with the `workspace:*` protocol, which `npm publish` does not resolve (only pnpm does). Every install of the affected packages failed with `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`. Restore `^` semver ranges, which changesets bumps automatically on release.
- 527195a: Close vote-tally poisoning (charter placeholders, fenced decoys, delegated-child hijack), apply council weights on the CLI, add `swarm-dao control`, and fail-close unknown gates / cascade+force / shell-free improvement anchors.
- Updated dependencies [527195a]
  - @guyghost/swarm-dao-core@1.0.1

## 0.5.0

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

- Updated dependencies [2da3218]
- Updated dependencies [96cf36b]
- Updated dependencies [f8d6167]
- Updated dependencies [9eee0bf]
- Updated dependencies [6487091]
- Updated dependencies [0a96294]
- Updated dependencies [f8d6167]
- Updated dependencies [72ad3ed]
  - @guyghost/swarm-dao-core@1.0.0

## 0.4.3

### Patch Changes

- 12860f6: restore the worker state-reporter fix and parent-linked child sessions

  The changeset-release merge (#147) resolved against a stale release branch
  and reverted these src changes while keeping their version bumps, so main
  briefly published changelog entries for code it no longer contained. This
  changeset re-declares the restored worker-reliability and child-session
  linkage code that the merge dropped.

## 0.4.2

### Patch Changes

- 9dd5891: Fix the `agent start` readiness race against herdr (`agent_pane_busy`). `herdr workspace create` returns before the fresh pane's shell has reached its interactive prompt, and `herdr agent start` classifies such a pane as busy instead of waiting — slower shell init under herd load (several agents working at once) made the failure intermittent and burned whole executor attempts (fresh workspace per retry, same race each time). `herdr agent start` is now retried on the SAME pane (1 s apart, via the new exported `startAgentUntilReady` helper) until the readiness budget (`startTimeoutMs`) is spent, in both the deliberation host adapter and the improvement-loop worker executor; any other herdr error code still fails immediately.
- 5fdc442: Read herdr's real `agent_status` lifecycle field when classifying settled agent states. herdr exposes `result.agent.agent_status`; the executors only read `agent.status`/`agent.state`, so the blocked-agent guard (approval/question UI) could never fire — a blocked worker was harvested as a confusing transcript error instead of the accurate "agent is blocked — it never produced a signal/vote" (issue #138). Applies to both the improvement-loop worker executor and the herdr deliberation host adapter; test fixtures now mirror the real herdr JSON contract.
- c393db4: Recover from `agent_prompt_stalled` instead of abandoning live workers. herdr's `agent prompt --wait` requires an observed state change within a hardcoded 5 s window; a fresh agent in a heavy repo under load can exceed it while the prompt was accepted and is being processed, and the executors treated the stall as a dead attempt — closing the workspace and retrying from scratch (issue #137, reproduced live: the agent answered while herdr reported `agent_prompt_stalled`). On stall, the new shared `promptAgentUntilSettled` helper grace-polls `agent get` (20 s default): if the agent came alive it waits for settle with `agent wait`; only a submission that stayed idle through the grace period is re-prompted, exactly once (a naive re-prompt risks double submission into a working agent).
- Updated dependencies [00c84a1]
  - @guyghost/swarm-dao-core@0.16.1

## 0.4.1

### Patch Changes

- Updated dependencies [5be1c48]
  - @guyghost/swarm-dao-core@0.16.0

## 0.4.0

### Minor Changes

- e536a70: Security hardening for GitHub code scanning alerts (all 31 open alerts resolved).

  **Shell-command construction (12 alerts):** every adapter runner now spawns commands as ARGV via `execFile` — the JS side never builds a shell command line, so prompts, labels, series ids and paths can never be shell-interpreted. `HerdrRunner.exec`, `TmuxRunner.exec` and `SandboxExecRunner` take `argv: readonly string[]`; `buildSandboxCommand` (shell-string builder) is replaced by `buildSandboxArgv` (the anchored command still runs through `sh -c` inside the container, which belongs to the image, not to this process). The tmux pane program remains a deliberate shell program — operator-owned config, single argv element to tmux.

  **Polynomial ReDoS (15 alerts):** all risky regexes rewritten linear — line-oriented section parsing (vote/reasoning extraction, delegation signals, delivery-plan phases and tasks, RICE metrics) with `[ \t]` classes instead of `\s`, no `[\s\S]*?` lookahead alternations; trailing-run trims (`/\n+$/`, `/-+$/`, `/\/+$/`) replaced by linear scans. Behavior preserved, including the echo-shadowing case where the first `## Vote` section carries no vote word.

  **Workflow permissions (2 alerts):** `ci.yml` declares `permissions: contents: read`.

### Patch Changes

- Updated dependencies [e536a70]
  - @guyghost/swarm-dao-core@0.15.0

## 0.3.0

### Minor Changes

- 3f6f71d: herdr child sessions by default for every multi-agent CLI flow. The new `swarm-dao deliberate <id>` makes every agent vote as a real coding agent in its own herdr child session, `swarm-dao roundtable` does the same for proposal ideas, and `swarm-dao implement <id> [<id>…]` dispatches one herdr child agent per proposal — multiple ids develop in parallel, each in its own execution worktree (requires `execution.isolation`). The CLI process is the parent session that pilots the children; attach with `herdr` to watch any child live. Kind and harvest options default from a new typed `herdr` section in `.dao/config.json` (`kind`, `keepPanes`, `timeoutMs`), overridable via `--kind`, `--keep-panes`, `--timeout-ms`. Also exports `herdrAgentName` from the herdr adapter and widens `ExecutionConfig.isolation` to include `"sandbox"` (already supported by GitWorkspace).

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

- 58601df: New herdr host: `createHerdrHostAdapter` runs each deliberation agent as a real coding agent inside an isolated herdr workspace (`herdr.dev`) — `workspace create` → `agent start --kind` (pi, claude, codex, grok, opencode, …) → `agent prompt --wait` → `agent read --source recent-unwrapped`, with automatic workspace cleanup unless `keepPanes`. herdr's lifecycle tracking means a blocked agent (approval/question UI) surfaces as an error output, never as a vote; the operator can attach to any agent pane live. Agent ids are sanitized into herdr's `[a-z][a-z0-9_-]{0,31}` name contract, per-call timeouts are honored, and `readFile`/`writeFile` are contained under the working directory. Thirteen unit tests plus a real-server integration suite (error path always; full agent round-trip behind `HERDR_IT=1`).
