---
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-herdr-adapter": minor
---

herdr child sessions by default for every multi-agent CLI flow. The new `swarm-dao deliberate <id>` makes every agent vote as a real coding agent in its own herdr child session, `swarm-dao roundtable` does the same for proposal ideas, and `swarm-dao implement <id> [<id>…]` dispatches one herdr child agent per proposal — multiple ids develop in parallel, each in its own execution worktree (requires `execution.isolation`). The CLI process is the parent session that pilots the children; attach with `herdr` to watch any child live. Kind and harvest options default from a new typed `herdr` section in `.dao/config.json` (`kind`, `keepPanes`, `timeoutMs`), overridable via `--kind`, `--keep-panes`, `--timeout-ms`. Also exports `herdrAgentName` from the herdr adapter and widens `ExecutionConfig.isolation` to include `"sandbox"` (already supported by GitWorkspace).
