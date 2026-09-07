# @guyghost/swarm-dao-herdr-adapter

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
