---
"@guyghost/swarm-dao-cli": minor
"@guyghost/swarm-dao-core": patch
---

cli: expose the proposal dry-run and acceptance criteria on the command line.

A red-zone proposal could not complete the control gate from a plain CLI
session: `mandatory-dry-run` reads `dryRunAt`, and only the MCP host tool
(`dao_dry_run`) could write it. The CLI now implements `dry-run <id>` through
the exact same `DryRunProposalUseCase`, so both surfaces record identical
evidence, and the red-zone refusal message points at both.

`propose` also gains a repeatable `--acceptance-criteria` flag. Without it the
acceptance-criteria gate could only ever warn, because the CLI had no way to
supply the criteria `CreateProposalCommand` already accepted.
