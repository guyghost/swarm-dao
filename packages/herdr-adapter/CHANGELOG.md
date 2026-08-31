# @guyghost/swarm-dao-herdr-adapter

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
