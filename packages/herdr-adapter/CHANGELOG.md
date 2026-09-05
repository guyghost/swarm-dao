# @guyghost/swarm-dao-herdr-adapter

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
