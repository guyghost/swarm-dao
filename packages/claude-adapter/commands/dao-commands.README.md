# `/dao:*` commands (generated)

> Auto-generated from `@guyghost/swarm-dao-core`'s `DaoCommandRegistry`.
> Do not edit by hand — run `bun run scripts/generate-commands.ts`.
> Claude Code derives command names from filenames (colon namespace in filename).

## Setup
- [`/dao:setup`](dao:setup.md) `[useDefaults=true]` — Initialize the DAO with the default 7 product agents

## Propose
- [`/dao:propose`](dao:propose.md) `title type description [acceptanceCriteria...] [affectedPaths...]` — Create a new proposal
- [`/dao:update-proposal`](dao:update-proposal.md) `proposalId [problemStatement] [acceptanceCriteria] [successMetrics] [rollbackConditions]` — Update structured fields on an open proposal

## Deliberate
- [`/dao:deliberate`](dao:deliberate.md) `proposalId` — Run swarm deliberation / build the dispatch plan
- [`/dao:record-outputs`](dao:record-outputs.md) `proposalId outputs[]` — Record sub-agent outputs and finalize deliberation

## Control
- [`/dao:control`](dao:control.md) `proposalId` — Run the quality-control gates

## Execute
- [`/dao:execute`](dao:execute.md) `proposalId` — Execute an approved / controlled proposal

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
- [`/dao:dry-run`](dao:dry-run.md) `proposalId` — Preview execution without applying changes
- [`/dao:roundtable`](dao:roundtable.md) — Ask every agent to suggest a proposal idea

## Governance
- [`/dao:propose-amendment`](dao:propose-amendment.md) `title description amendmentType [agentId] [agentChanges] [configChanges] [addGates] [removeGates]` — Propose an amendment (agents, config, quorum, gates)

## GitHub
- [`/dao:github-config`](dao:github-config.md) `--token <t> --owner <o> --repo <r>` — Configure the GitHub integration
- [`/dao:github-branch`](dao:github-branch.md) `proposalId` — Create a GitHub branch for a proposal
- [`/dao:github-pr`](dao:github-pr.md) `proposalId --head-branch <b>` — Open a GitHub pull request for a proposal
