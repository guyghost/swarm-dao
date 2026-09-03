# `/dao:*` commands (generated)

> Auto-generated from `@guyghost/swarm-dao-core`'s `DaoCommandRegistry`.
> Do not edit by hand — run `bun run scripts/generate-commands.ts`.
> Claude Code derives command names from filenames (colon namespace in filename).

## Setup
- [`/dao:setup`](dao:setup.md) `[useDefaults=true]` — Initialize the DAO with the default 8 product agents

## Propose
- [`/dao:propose`](dao:propose.md) `title type description [acceptanceCriteria...] [affectedPaths...]` — Create a new proposal
- [`/dao:update-proposal`](dao:update-proposal.md) `proposalId [problemStatement] [acceptanceCriteria] [successMetrics] [rollbackConditions]` — Update structured fields on an open proposal

## Deliberate
- [`/dao:deliberate`](dao:deliberate.md) `proposalId` — Run swarm deliberation / build the dispatch plan
- [`/dao:record-outputs`](dao:record-outputs.md) `proposalId outputs[]` — Record sub-agent outputs and finalize deliberation

## Control
- [`/dao:control`](dao:control.md) `proposalId` — Run the quality-control gates
- [`/dao:graph-submit`](dao:graph-submit.md) `runId type producer payload evidence` — Submit an AI-source signal to a Graph Engineering run (model/implementation artifacts only; human events go through the CLI)
- [`/dao:product-submit`](dao:product-submit.md) `runId type producer payload evidence` — Submit an AI-source signal to a product-loop run (explorer/aggregator/proposer artifacts only; human events go through the CLI)

## Execute
- [`/dao:execute`](dao:execute.md) `proposalId` — Execute an approved / controlled proposal
- [`/dao:improve-once`](dao:improve-once.md) `seriesId [evidenceRoot] [cycleRoot]` — Advance an improvement series by one state-authorized effect (deterministic executor; persisted worker configuration, per-series worktree)

## Ship
- [`/dao:ship`](dao:ship.md) `proposalId [cascade] [force]` — Ship a controlled proposal (optionally cascade dependencies)

## Retro
- [`/dao:rollback`](dao:rollback.md) `proposalId` — Revert an executed proposal to its pre-execution snapshot
- [`/dao:rate`](dao:rate.md) `proposalId score comment` — Rate a proposal outcome (1–5 stars)

## Discover
- [`/dao:help`](dao:help.md) — Show the DAO workflow and every available command
- [`/dao:status`](dao:status.md) — Show the governance health dashboard
- [`/dao:list`](dao:list.md) `[--status] [--type]` — List all proposals
- [`/dao:agents`](dao:agents.md) — List the configured DAO agents
- [`/dao:plan`](dao:plan.md) `proposalId` — Show the delivery plan for a proposal
- [`/dao:artefacts`](dao:artefacts.md) `proposalId` — View the auto-generated artefacts for a proposal
- [`/dao:audit`](dao:audit.md) `[proposalId]` — View the audit trail
- [`/dao:attention`](dao:attention.md) `[--source <graph-engineering|improvement-loop|improvement-series|product-loop>,...]` — List pending human gates across workflow runs (read-only)
- [`/dao:graph-status`](dao:graph-status.md) `runId [evidenceRoot]` — Read a Graph Engineering run snapshot (read-only)
- [`/dao:improve-status`](dao:improve-status.md) `seriesId [evidenceRoot]` — Read an improvement series snapshot (read-only)
- [`/dao:product-status`](dao:product-status.md) `runId [evidenceRoot]` — Read a product-loop run snapshot (read-only)
- [`/dao:dry-run`](dao:dry-run.md) `proposalId` — Preview execution without applying changes
- [`/dao:roundtable`](dao:roundtable.md) — Ask every agent to suggest a proposal idea

## Governance
- [`/dao:check-edit`](dao:check-edit.md) `paths` — Check whether paths may be edited under the configured mode
- [`/dao:propose-amendment`](dao:propose-amendment.md) `title description amendmentType [agentId] [agentChanges] [configChanges] [addGates] [removeGates]` — Propose an amendment (agents, config, quorum, gates)
- [`/dao:reject-proposal`](dao:reject-proposal.md) `proposalId --reason <text>` — Reject a proposal with an auditable human reason

## GitHub
- [`/dao:github-config`](dao:github-config.md) `--owner <o> --repo <r> [--issues]` — Configure the GitHub integration (auth via the gh CLI)
- [`/dao:github-branch`](dao:github-branch.md) `proposalId` — Create a GitHub branch for a proposal
- [`/dao:github-pr`](dao:github-pr.md) `proposalId --head-branch <b>` — Open a GitHub pull request for a proposal
