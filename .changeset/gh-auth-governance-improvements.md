---
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-mcp": minor
"@guyghost/swarm-dao-opencode-adapter": minor
"@guyghost/swarm-dao-pi-adapter": minor
---

GitHub auth via the `gh` CLI; auditable rejection path; vote preservation; shared project brief.

- **Breaking (config):** GitHub authentication is delegated to the `gh` CLI — run `gh auth login` once. `dao_config_github` / `swarm-dao github-config` no longer take a `--token`; they store `owner`, `repo` and an `issues` opt-in (track proposal modifications as GitHub issues). `DAO_GITHUB_TOKEN` is no longer read.
- **New:** `dao_reject` tool and `swarm-dao reject-proposal <id> --reason <text>` — auditable human REJECT/DISCARD for open, deliberating and approved proposals.
- **Fix:** deliberation merges votes instead of replacing them — human/CLI votes survive, and agents without a `## Vote` section no longer produce fabricated abstentions.
- **New:** a deterministic project brief (manifest, README, layout, changelog) is built once per deliberation/round table and injected into every participant's prompt.
