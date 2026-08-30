# @guyghost/swarm-dao-tmux-adapter

## 0.2.0

### Minor Changes

- 3113589: New tmux host: `createTmuxHostAdapter` runs each deliberation agent as its own detached tmux pane (the swarm-forge execution model) — watchable live via `tmux attach`, with prompt/output/completion markers under `.dao/tmux/<proposalId>/<agentId>/`. The agent command runs as the session program (no pane-shell typing race), stale completion markers are purged per run, timeouts kill the session with a deterministic error output, and `keepSessions` preserves pane scrollback for inspection. Outputs feed the same deterministic tally as every other host. Configured via `tmux.command` (`$PROMPT` carries the deliberation prompt) in `.dao/config.json`.
