# @guyghost/swarm-dao-tmux-adapter

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
