---
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-herdr-adapter": minor
"@guyghost/swarm-dao-improvement": minor
"@guyghost/swarm-dao-tmux-adapter": minor
---

Security hardening for GitHub code scanning alerts (all 31 open alerts resolved).

**Shell-command construction (12 alerts):** every adapter runner now spawns commands as ARGV via `execFile` — the JS side never builds a shell command line, so prompts, labels, series ids and paths can never be shell-interpreted. `HerdrRunner.exec`, `TmuxRunner.exec` and `SandboxExecRunner` take `argv: readonly string[]`; `buildSandboxCommand` (shell-string builder) is replaced by `buildSandboxArgv` (the anchored command still runs through `sh -c` inside the container, which belongs to the image, not to this process). The tmux pane program remains a deliberate shell program — operator-owned config, single argv element to tmux.

**Polynomial ReDoS (15 alerts):** all risky regexes rewritten linear — line-oriented section parsing (vote/reasoning extraction, delegation signals, delivery-plan phases and tasks, RICE metrics) with `[ \t]` classes instead of `\s`, no `[\s\S]*?` lookahead alternations; trailing-run trims (`/\n+$/`, `/-+$/`, `/\/+$/`) replaced by linear scans. Behavior preserved, including the echo-shadowing case where the first `## Vote` section carries no vote word.

**Workflow permissions (2 alerts):** `ci.yml` declares `permissions: contents: read`.
