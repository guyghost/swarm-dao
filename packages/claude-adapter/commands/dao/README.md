# `/dao` commands (generated)

> Auto-generated from `@guyghost/swarm-dao-core`'s `DaoCommandRegistry`.
> Do not edit by hand — run `bun run scripts/generate-commands.ts`.
> Claude Code exposes each file as `/dao:<id>` (colon namespace, native completion).

## Setup
- [`/dao:setup`](setup.md) `[useDefaults=true]` — Initialize the DAO with the default 7 product agents

## Propose
- [`/dao:propose`](propose.md) `title type description [acceptanceCriteria...] [affectedPaths...]` — Create a new proposal
- [`/dao:update-proposal`](update-proposal.md) `proposalId [problemStatement] [acceptanceCriteria] [successMetrics] [rollbackConditions]` — Update structured fields on an open proposal

## Deliberate
- [`/dao:deliberate`](deliberate.md) `proposalId` — Run swarm deliberation / build the dispatch plan
- [`/dao:record-outputs`](record-outputs.md) `proposalId outputs[]` — Record sub-agent outputs and finalize deliberation

## Control
- [`/dao:control`](control.md) `proposalId` — Run the quality-control gates

## Execute
- [`/dao:execute`](execute.md) `proposalId` — Execute an approved / controlled proposal

## Ship
- [`/dao:ship`](ship.md) `proposalId [cascade] [force]` — Ship a controlled proposal (optionally cascade dependencies)

## Retro
- [`/dao:rollback`](rollback.md) `proposalId` — Revert an executed proposal to its pre-execution snapshot
- [`/dao:rate`](rate.md) `proposalId score comment` — Rate a proposal outcome (1–5 stars)

## Discover
- [`/dao:help`](help.md) — Show the DAO workflow and every available command
- [`/dao:status`](status.md) — Show the governance health dashboard
- [`/dao:list`](list.md) `[--status] [--type]` — List all proposals
- [`/dao:agents`](agents.md) — List the configured DAO agents
- [`/dao:plan`](plan.md) `proposalId` — Show the delivery plan for a proposal
- [`/dao:artefacts`](artefacts.md) `proposalId` — View the auto-generated artefacts for a proposal
- [`/dao:audit`](audit.md) `[proposalId]` — View the audit trail
- [`/dao:dry-run`](dry-run.md) `proposalId` — Preview execution without applying changes
- [`/dao:roundtable`](roundtable.md) — Ask every agent to suggest a proposal idea

## Governance
- [`/dao:propose-amendment`](propose-amendment.md) `title description amendmentType [agentId] [agentChanges] [configChanges] [addGates] [removeGates]` — Propose an amendment (agents, config, quorum, gates)

## GitHub
- [`/dao:github-config`](github-config.md) `--token <t> --owner <o> --repo <r>` — Configure the GitHub integration
- [`/dao:github-branch`](github-branch.md) `proposalId` — Create a GitHub branch for a proposal
- [`/dao:github-pr`](github-pr.md) `proposalId --head-branch <b>` — Open a GitHub pull request for a proposal

## Guided aliases (hand-authored)
- `/dao-propose` — scaffold a proposal with prompts for every field.
- `/dao-deliberate` — deliberate, spawn sub-agents, record outputs, control.
- `/dao-ship` — control, execute, ship, and rate in one guided flow.
