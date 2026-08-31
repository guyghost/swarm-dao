---
"@guyghost/swarm-dao-pi-adapter": minor
"@guyghost/swarm-dao-core": patch
---

`/dao <subcommand>` now executes instead of routing: Pi slash commands cannot invoke Pi tools, but the adapter owns both surfaces, so every registry command (propose, deliberate, check, execute, ship, rollback, plan, artefacts, dry-run, roundtable, rate, update-proposal, check-edit, github-*) now runs its tool logic inline and renders the result. Quote-aware argument parsing supports ids, titles, flags (`--cascade`, `--force`, `--token/owner/repo`, …) and usage messages on invalid input. Also fixes `dao_github_create_branch` / `dao_github_open_pr` reporting "GitHub not configured" immediately after a successful `dao_config_github` in the same session: the in-memory token is now reused when the persisted token is redacted and `DAO_GITHUB_TOKEN` is unset (same owner/repo only).
