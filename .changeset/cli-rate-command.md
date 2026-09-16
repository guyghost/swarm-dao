---
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-core": minor
---

CLI: new `rate <id> --score <1-5> --comment <text> [--by <name>]` command so
headless pipelines can record post-execution outcome ratings without going
through the MCP `dao_rate` tool. It reuses `RateProposalUseCase` (executed
status gate, 1–5 score validation), records an `outcome-rated` audit entry
with the rater, and prints the recomputed overall score. The `rate` registry
command is now exposed to the `cli` host.
