# DAO Command Registry — the command model

> Source of truth: [`packages/core/src/commands/registry.ts`](../packages/core/src/commands/registry.ts).
> If anything below drifts from the registry, **the registry wins**. This document is
> the human-readable projection of that registry — it does not define commands.

## Why a registry

Every host adapter (Pi, OpenCode, Copilot, Claude Code, Codex, the generic MCP server,
the standalone CLI) projects the **same** command set into its native completion surface.
No adapter hardcodes a command list. Adding a command means adding one entry to the
registry; every host picks it up.

## Discipline (Model → Review → Implement → Verify)

- The registry only **names** commands and maps them to existing handlers.
- It never re-declares proposal-status transitions — those belong to the XState machine
  in [`packages/core/src/governance/proposal.machine.ts`](../packages/core/src/governance/proposal.machine.ts)
  (see [`models/README.md`](../models/README.md)).
- No entry lets an LLM decide a state transition. The LLM produces content inside
  `dao_propose` / deliberation; **the model decides**.

## Lifecycle phases

Commands are grouped into ten phases, in canonical order:

| # | Phase | Label | Purpose |
|---|---|---|---|
| 1 | `init` | Setup | Stand the DAO up |
| 2 | `propose` | Propose | Create / edit proposals |
| 3 | `deliberate` | Deliberate | Run the swarm, fold outputs |
| 4 | `control` | Control | Quality gates |
| 5 | `execute` | Execute | Apply an approved change |
| 6 | `ship` | Ship | Finalize + cascade |
| 7 | `retro` | Retro | Rollback + rate outcomes |
| 8 | `discover` | Discover | Read-only inspection |
| 9 | `governance` | Governance | Amend the DAO itself |
| 10 | `github` | GitHub | Branch + PR integration |

## Hosts

```text
claude · pi · opencode · mcp · cli · copilot · codex
```

Each command declares which hosts expose it (`hosts: [...]`; `undefined` = every host).
For example, `vote` is CLI-only (deterministic), and the GitHub commands are MCP-only
(Copilot, Claude, Codex, generic MCP).

## Command catalogue

> This table is the registry rendered. Every `/dao help` output and every generated
> slash-command file is produced from it. Aliases: `check → control`,
> `dashboard → status`, `record → record-outputs`.

### Setup
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao setup` | `[useDefaults=true]` | `dao_setup` | Initialize the DAO with the default 7 product agents |

### Propose
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao propose` | `title type description [acceptanceCriteria...] [affectedPaths...]` | `dao_propose` | Create a new proposal |
| `/dao update-proposal` | `proposalId [problemStatement] [acceptanceCriteria] [successMetrics] [rollbackConditions]` | `dao_update_proposal` | Update structured fields on an open proposal |

### Deliberate
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao deliberate` | `proposalId` | `dao_deliberate` | Run swarm deliberation / build the dispatch plan |
| `/dao record-outputs` | `proposalId outputs[]` | `dao_record_outputs` | Record sub-agent outputs and finalize deliberation |

### Control
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao control` | `proposalId` | `dao_control` | Run the quality-control gates |

### Execute
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao execute` | `proposalId` | `dao_execute` | Execute an approved / controlled proposal |

### Ship
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao ship` | `proposalId [cascade] [force]` | `dao_ship` | Ship a controlled proposal (optionally cascade dependencies) |

### Retro
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao rollback` | `proposalId` | `dao_rollback` | Revert an executed proposal to its pre-execution snapshot |
| `/dao rate` | `proposalId score comment` | `dao_rate` | Rate a proposal outcome (1–5 stars) |

### Discover
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao help` | — | `dao_help` | Show the DAO workflow and every available command |
| `/dao status` | — | `dao_dashboard` | Show the governance health dashboard |
| `/dao list` | `[--status] [--type]` | `dao_list` | List all proposals |
| `/dao agents` | — | `dao_agents` | List the configured DAO agents |
| `/dao plan` | `proposalId` | `dao_plan` | Show the delivery plan for a proposal |
| `/dao artefacts` | `proposalId` | `dao_artefacts` | View the auto-generated artefacts for a proposal |
| `/dao audit` | `[proposalId]` | `dao_audit` | View the audit trail |
| `/dao dry-run` | `proposalId` | `dao_dry_run` | Preview execution without applying changes |
| `/dao roundtable` | — | `dao_roundtable` | Ask every agent to suggest a proposal idea |

### Governance
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao propose-amendment` | `title description amendmentType [agentId] [agentChanges] [configChanges] [addGates] [removeGates]` | `dao_propose_amendment` | Propose an amendment (agents, config, quorum, gates) |

### GitHub
| Command | Args | Tool | Summary |
|---|---|---|---|
| `/dao github-config` | `--token <t> --owner <o> --repo <r>` | `dao_config_github` | Configure the GitHub integration |
| `/dao github-branch` | `proposalId` | `dao_github_create_branch` | Create a GitHub branch for a proposal |
| `/dao github-pr` | `proposalId --head-branch <b>` | `dao_github_open_pr` | Open a GitHub pull request for a proposal |

## How hosts project it

| Host | Projection |
|---|---|
| **Claude Code** | `/dao:<id>` slash commands — generated files in `packages/claude-adapter/commands/` (`bun run generate-commands`). |
| **GitHub Copilot** | `dao_*` MCP tools; `/dao <id>` invocation surfaced via `copilot-instructions.md`. |
| **OpenAI Codex** | `dao_*` MCP tools; `/dao <id>` invocation surfaced via `AGENTS.md`. |
| **Pi / OpenCode** | Native tools registered by the extension/plugin. |
| **Generic MCP** | `dao_*` tools over stdio (`@guyghost/swarm-dao-mcp`). |
| **CLI** | `swarm-dao <id>` subcommands; adds `vote`, `show`, `init`, `config`. |

## Adding a command

1. Add one `DaoCommand` entry to `DAO_COMMANDS` in the registry.
2. Implement the handler (or map to an existing MCP tool).
3. Re-run each host's generation step (Claude: `bun run generate-commands`).
4. Update this document to match (it is human-maintained; the registry is the test).

## See also

- [MCP host integration guide](./MCP_INTEGRATION.md) — the workflow, contract, and
  per-host spawn patterns that surround these commands.
- [Behavioral models](../models/README.md) — the proposal lifecycle these commands invoke.
