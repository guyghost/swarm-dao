# @guyghost/swarm-dao-core

## 3.0.0

### Major Changes

- 2b03f27: Breaking change: the public `branchDirName` output and on-disk branch directory
  layout change. This requires a major release so consumers using `^2.2.1` do not
  automatically receive the storage migration. Automatic migration of unambiguous
  legacy directories does not preserve compatibility with concurrently running
  older hosts.
  
  Preserve DAO state when Git branch or worktree discovery fails. Give branch
  storage an exact-name hash, migrate unambiguous legacy directories, and preserve
  ambiguous legacy data with an actionable error instead of sharing branch state.
  Stop running DAO hosts before upgrading so no old process continues writing to
  a legacy branch directory after its migration.
  
  Reject out-of-range quorum amendments both when proposed and when applied.
  Refresh persistence locks through the owned file descriptor without truncating
  the lock payload; allow newly created, incomplete locks time to finish writing.

### Minor Changes

- e7ef6a2: Remove the process-global DAO repository singleton (getState/setRepository/Legacy); hosts and handlers own FileDaoStateRepository instances per ADR-002 rule 3.
- 4aa7b9c: Add a repository-native software delivery coordinator that connects Product Loop qualification and budget, exact-hash Graph approval, reversible local staging, observation, and rollback.
  
  Also publish the Product Loop human deploy-authorization signal fix required by the coordinator.
- 2f510a9: Scope audit + Pi slash reads to session repositories; extend architecture contracts; prune unused core export maps; align sandbox defaults (doctor/docs); raise coverage floors; schedule-only real-runtime CI.
- c3cf299: Reliability hardening: ADR-007 docs, layout-aware doctor, pure delegation machines in models/ (injected clock), repository-scoped list/agents/plan/artefacts/dashboard handlers, Pi tool parity (help/list/agents/control), adapter tests covering src/, real-runtime CI job, publish coverage+doc-links+OSV audit gates.

### Patch Changes

- 28d24ca: Fix six defects found in the bug hunt (round 2), each with a reproduction test:
  
  - Red-zone classification reads the whole proposal, not just `title`/`description`
    (problem statement, acceptance criteria, context, success metrics, rollback
    conditions, affected paths, structured `content`), and `UpdateProposalUseCase`
    reclassifies after an edit — a security-sensitive statement added after creation
    can no longer stay orange and skip the mandatory red-zone dry-run.
  - `tallyVotes` counts abstentions in `votingAgents`: an abstention is a cast vote
    (it already weighs into the quorum), so "Votes Cast: X / Y" no longer
    under-reports participation.
  - The ship-audit confirmation is spent only when the ship actually happened: a
    failed `dao_ship` (`ok: false`, e.g. unexecuted dependencies) now releases the
    claim without consuming the confirmation, so the unchanged retry proceeds
    instead of forcing a fresh two-call challenge cycle.
  - `parseDeliveryPlan` accepts the em-dash separator `formatPlan` emits, so a
    self-produced plan no longer re-parses with zero tasks (silent data loss).
  - Bitbucket configuration validates `workspace`/`repo` at the chokepoint
    (GitHub #166 parity) and the API routes percent-encode the slugs and the base
    branch — a `/` in `workspace`, `repo`, or a branch name like `feature/x` can no
    longer re-route the request or 404.
- 4443f1a: Fix five latent core defects found in the bug hunt:
  
  - Normalize batch size in `dispatchSwarm`/`runRoundTable` so a zero/negative/NaN
    `maxConcurrent` (editable config or `config-update` amendment) can no longer
    stall deliberation forever; the amendment now rejects a non-positive value.
  - Repair and validate `state.json` `config` on load: a partial `{ "config": {} }`
    used to replace the whole default and crash `runGates`/`tallyVotes`.
  - Emit raw `le` bucket boundaries in the Prometheus exposition instead of the
    internal `le_10` keys.
  - Bound RICE inputs before scoring so `effort: 0` no longer yields `Infinity`.
  - Share the tally's vote-heading matcher with the sequential pipeline so the
    rendered `Vote`/`Vote:` form cannot leak an upstream vote into later analyses.
  
  Second pass (low-severity hardening):
  
  - Risk classification matches the "auth" family on word boundaries (with
    prefixes: unauthorized/reauthentication/OAuth/deauthorize) so
    "author"/"authoritative" no longer force the red zone while the security forms
    still do; the unambiguous stems (security, token, password, …) stay substring
    based so compounds like "cybersecurity"/"passwordless" keep matching.
  - Amendments reject non-numeric / out-of-range agent weights and refuse to add
    a duplicate agent id (identity keys must stay unique).
  - The ship-audit claim is held until the confirmation is consumed, so two
    concurrent confirms can never proceed from one challenge (INV-6); callers
    release it on error paths.
  - Decision-brief approval score uses the decisive (non-abstain) weight, matching
    `tallyVotes`.
  - Git ref validation rejects consecutive `/` segments, as documented.
- ec03c6f: Durable audit appends, lock revalidation before commit, and fail-closed improvement sandboxes.
- f38bea6: Harden the observability/summary surfaces flagged in the bug hunt:
  
  - Alert rules can read a histogram aggregate (`count` | `sum` | `avg` | `p50` |
    `p95` | `p99`); the default "High Deliberation Time" rule now reads `p95` as
    its description always claimed, instead of comparing the observation count.
    The never-implemented `duration` field is removed from `AlertRule`.
  - `formatHealthScore` emits a well-formed metric table (header now matches the
    rows, and each row carries its closing pipe).
  - `config.maxVoteWeight` is accepted by the `config-update` amendment with a
    bound (`finite number >= 1`); a below-1 value is rejected because it would
    make `addVoteOn` reject every vote. `repairConfig` drops an invalid
    `maxVoteWeight` from a hand-edited `state.json` for the same reason.
  - `HostAdapter.spawnAgents` is documented as a raw-prompt parallel fan-out with
    no dispatch layer.

## 2.2.1

### Patch Changes

- 05920af: cli: expose the proposal dry-run and acceptance criteria on the command line.
  
  A red-zone proposal could not complete the control gate from a plain CLI
  session: `mandatory-dry-run` reads `dryRunAt`, and only the MCP host tool
  (`dao_dry_run`) could write it. The CLI now implements `dry-run <id>` through
  the exact same `DryRunProposalUseCase`, so both surfaces record identical
  evidence, and the red-zone refusal message points at both.
  
  `propose` also gains a repeatable `--acceptance-criteria` flag. Without it the
  acceptance-criteria gate could only ever warn, because the CLI had no way to
  supply the criteria `CreateProposalCommand` already accepted.
- 10092d2: core: stop losing proposals the archive signature cannot see.
  
  Two related defects could destroy proposal data on a write:
  
  1. A closed proposal that only `state.json` carries (the layout older CLIs
     wrote) was removed from the live partition by `partitionState`, but the
     archive-changed check compared `id:status` signatures — which already
     included it after loading. The archive was therefore not rewritten and the
     proposal ended up in neither file. The loader now marks the archive dirty
     when it takes over a closed proposal that `archive.json` does not hold yet.
  
  2. The archive signature ignores field-level changes, so any use case that
     mutates a closed proposal must call `markArchivedDirty()`. The dry-run use
     case did not, which silently dropped `dryRunAt`/`dryRunCanProceed`: the
     mandatory-dry-run gate reported a completed dry-run that was never persisted.
  
  `isArchivedStatus` also moves to `domain/proposal-status.ts` (re-exported from
  its previous home) so application code can consult the archived/live rule
  without importing infrastructure.

## 2.2.0

### Minor Changes

- 6398cbc: External DAO home (ADR-007): git projects no longer get a `.dao/` directory.
  
  DAO state now defaults to `~/.swarm-dao/<project-id>/branches/<branch>/`
  (override the root with `SWARM_DAO_HOME`), keyed deterministically from the
  realpath of the repo — linked worktrees of one repo share a project, two
  clones never do. Config and agent definitions stay shared at the project
  root; `state.json`, `decisions/`, and the audit trail are branch-scoped.
  
  - Passive GC removes the state of deleted branches/worktrees on every state
    load; guarded by `project.json.repoPath`, never touching the current
    branch, deletions logged
  - `swarm-dao gc [--dry-run]` — explicit sweep behind the same guards
  - Projects with an existing `<cwd>/.dao/` keep legacy storage unchanged
    (resolution precedence: legacy `.dao` > home; no git identity also stays
    legacy)
  
  See `docs/ADR-007-external-dao-home.md` for the full decision.

## 2.1.0

### Minor Changes

- 60f7d88: Config schema versioning: see and align `.dao/config.json` with the running tool.
  
  `ProjectConfig` gains an explicit `configVersion` field (files without one are
  legacy v0). `loadConfig` validates it (non-negative integer) and the new
  `effectiveConfigVersion`/`CURRENT_CONFIG_VERSION` exports let callers compare
  a config's schema version with the tool's. Migrations are pure, ordered
  functions (`migrateProjectConfig`); `upgradeConfig` applies them and persists
  the result, refusing configs written by a newer tool (no downgrade).
  
  - `swarm-dao config upgrade` — align an outdated config with the current
    schema version (idempotent, preserves all fields)
  - `swarm-dao doctor` — new "config version" check: green when aligned,
    warn when the config is older (hint: `swarm-dao config upgrade`), fail when
    the config is newer than the tool (hint: upgrade swarm-dao)

## 2.0.0

### Major Changes

- c20ef3d: Remove the default-model notion — agents inherit the main model (ADR-006).
  
  A model is now either **pinned explicitly in configuration** or **inherited
  from the main model**; there is no DAO-wide default layer anymore. Resolution
  chain (first match wins): `agent.model` → `delegationProfile[archetype].model`
  → parent agent → parent session (the main model) → host main model → the
  `"default"` sentinel (host decides, no flag emitted).
  
  **Breaking:**
  
  - `DAOConfig.defaultModel` is removed (including its hardcoded
    `"z.ai/GLM-5.1"` fallback in `DEFAULT_CONFIG`). DAOs that relied on it as a
    fleet-wide pin must set `model:` per agent frontmatter or delegation
    profile instead. Legacy `defaultModel` keys in `.dao/config.json` are
    ignored (that file never carried the field).
  - `DelegationProfileEntry.defaultModel` is renamed to `model` — it is an
    explicit user spec, not a default; its rank in the chain is unchanged.
  - `buildModelResolutionContext`, `buildChildModelResolutionContext`, and
    `createDispatchModelContext` drop their `configDefaultModel` parameter.
  - `config-update` amendments no longer accept `defaultModel`.
  
  Behavioral effect: on hosts without session-model detection (headless CLI,
  MCP, CI), agents now run on the host's own main model — or emit no model flag
  at all — instead of silently running on a hardcoded model.

### Minor Changes

- b7f55eb: Move the audit trail to an append-only `audit.jsonl` (ADR-005, phase 2 of
  ADR-004).
  
  Audit entries now live in `.dao/audit.jsonl` — one compact JSON line each,
  appended (never rewritten) on persist. `state.json` no longer carries the
  trail, so no-op persist cost is O(open proposals) regardless of DAO age:
  measured 1.23 ms → 0.33 ms with 5000 audit entries and no measurable change
  to the other persistence cases.
  
  - Load merges the trail into the in-memory `auditLog`, deduplicating by id;
    torn or corrupt lines (crash mid-append) are skipped with a warning and
    never fatal
  - The trail is appended **before** `state.json` in the same locked section:
    a crash in between leaves the trail durably ahead of the state (a recorded
    action must not vanish); post-recovery re-appends are harmless
  - Legacy inline `auditLog` migrates to the JSONL on the first writing
    persist; `nextAuditId` is repaired past the trail's max id
  - `DaoStateRepositoryPort` API is unchanged
- fd1e0d1: Archive closed proposals out of `state.json` (ADR-004).
  
  Closed proposals and their satellite records (`outcomes`, `artefacts`,
  `snapshots`, `verifications`, `controlResults`, `deliveryPlans`) move to
  `.dao/archive.json`; `state.json` keeps only open/deliberating proposals.
  The in-memory `DAOState` stays a single merged view — `get()` is
  unchanged for every consumer. On open, the archive is merged back
  (archived ids shadow stale live copies); on persist, the archive is
  written before `state.json` (crash ordering), and only when its
  structural signature changed, `markArchivedDirty()` was called, or it is
  not yet on disk.
  
  `DaoStateRepositoryPort` gains `markArchivedDirty()`: use cases mutating
  values behind the archive's structural signature (re-rating an existing
  outcome, re-executing plan/snapshot writes) must call it. Structural
  changes (closures, status transitions, new satellite entries) are
  detected automatically. Legacy monolithic `state.json` files migrate on
  the first writing persist; `repairCounters` now accounts for archived
  ids so restored backups cannot collide.
  
  Measured (2000 closed + 20 open proposals): no-op persist 17.5 ms →
  **0.30 ms** (66×), touch-open persist → **1.57 ms**; `state.json`
  11 MB → 2 KB.

### Patch Changes

- e256fbc: Skip the O(proposals) decision sweep when a persist has nothing to write.
  
  Decision records are a pure function of `state.proposals`, so when the
  serialized state matches the last write the per-decision checks cannot
  change: `hasPendingWrites` short-circuits after the state check and
  `persistDecisions` returns early when the serialized index matches the
  write cache. A `decisionsPending` flag forces the full sweep after a
  persist that failed mid-way, keeping failure-retry behavior identical.
  
  Standalone effect is within noise on the official suite; kept as
  groundwork for ADR-004 (proposal archive), where the index guard keeps
  archive-only persists free of the O(closed) decision sweep. Adds a
  persistence benchmark case for the unchanged-state-with-closed-proposals
  regime.

## 1.1.0

### Minor Changes

- 3aa2664: Add a TypeSafe-style classifier verdict: coding-loop workers emit closed-vocabulary JSON, the harness validates it without throwing, and evaluateAttempt composes that signal with tool evidence so done cannot skip tests or Graph evaluation.
- d722194: CLI: new `rate <id> --score <1-5> --comment <text> [--by <name>]` command so
  headless pipelines can record post-execution outcome ratings without going
  through the MCP `dao_rate` tool. It reuses `RateProposalUseCase` (executed
  status gate, 1–5 score validation), records an `outcome-rated` audit entry
  with the rater, and prints the recomputed overall score. The `rate` registry
  command is now exposed to the `cli` host.
- 6b7d790: Graph Engineering retries after failed evaluation are now system-owned: EVALUATE / IMPLEMENTATION_FAILED with remaining budget auto-continue to implementing. There is no RETRY_AUTHORIZED human event on a graph run; model-hash approval and cancel stay human.

### Patch Changes

- 9cc48a9: Wire the classifier verdict into Graph Engineering implementing: the host prepends CLASSIFIER_CHARTER, routes on evaluateAttempt, and only then emits IMPLEMENTATION_READY or IMPLEMENTATION_FAILED.

## 1.0.2

### Patch Changes

- d740001: Fix vote tally harvesting 0 votes from rendering TUIs (herdr + pi, issue #178): the `## Vote` / `## Reasoning` heading patterns now also accept the rendered form a terminal leaves on screen (`Vote`, `  Vote:`, `Reasoning`) where the `##` glyphs are gone. Charter placeholders (`for | against | abstain`, `<for|against|abstain>`) remain inert, and the raw `## Vote` form keeps parsing as before.

## 1.0.1

### Patch Changes

- 527195a: Close vote-tally poisoning (charter placeholders, fenced decoys, delegated-child hijack), apply council weights on the CLI, add `swarm-dao control`, and fail-close unknown gates / cascade+force / shell-free improvement anchors.

## 1.0.0

### Major Changes

- 72ad3ed: Governance integrity hardening (issues #153–#169).

  - Core: revision-based optimistic concurrency (stateRevision) — a stale writer now fails persist() instead of silently dropping votes; both load paths repair ID counters; corrupt state.json gets a clear error plus an automatic backup before shape repair; token-owned lock files with heartbeat; atomic writes for contained files and the GitHub config; updateStorageSettings runs under the DAO lock; ship-audit claim locks are reclaimable when their owner is gone.
  - Core: tallyVotes grounds the quorum denominator in the configured council (silent members carry their configured weight), never undercuts the votes cast, and compares thresholds as exact fractions — Math.round no longer decides approvals.
  - Core: addVote replaces the same agent's prior vote, refuses votes outside open/deliberating and bounds weight (config.maxVoteWeight, default 3).
  - Core: proposal machine guards recompute the tally and replay the gates instead of trusting the event payload; guarded events require config.
  - Core: deliberation rollback on worker failure (ERROR + persist + audit) and a new ABORT_DELIBERATION transition (deliberating → open); deliberationStartedAt recorded.
  - Core: delegation-closed gate consults a persisted cross-process in-flight marker, so INV-8 can actually block.
  - Core: risk-threshold gate fails closed when no risk scores were produced; control failures transition failed by default (failOnGateFailure opt-out); dependency cycles rejected at creation; dependency-readiness uses transitive closure; cascade ship reports its shipped prefix on failure.
  - Core: GitHub owner/repo/headBranch validated before persistence and before any gh api call.
  - MCP: declared input schemas are enforced at runtime via a single schema registry (no more NaN ids, unbounded scores or forged event enums).
  - herdr: contained path resolution returns the resolved path (TOCTOU symlink escape closed).
  - CLI/tmux/herdr: HostAdapter.exec routes through the core's shell-free execCommand.

### Minor Changes

- 2da3218: Agent runtime configuration: per-agent LLM model and harness (pi, claude, codex, copilot, opencode).

  - Core: `runtime.defaultHarness` / `runtime.harnessModelFlag` project config, `harness` agent frontmatter, deterministic resolution (D1: agent → project → host default), typed E1–E5 failures surfaced per-agent instead of throwing. Runtime resolution activates only when a signal exists — hosts that never opted in keep the legacy dispatch.
  - Adapters: herdr spawns `harness <kind> -- <args> --model <model>`; tmux supports per-agent `agentCommands`; pi enforces the host boundary (only "pi" harness); opencode/mcp declare their host default.
  - CLI: `dao child` gains `--harness-model-flag`, tmux `agentCommands`, and the kind fallback chain `--kind` → `herdr.kind` → `runtime.defaultHarness` → `pi`.

- f8d6167: Strict validated loadConfig: ENOENT returns defaults, invalid JSON/enums throw with path. Validates mode, execution.isolation, deliberation, ship, delegation, herdr/tmux timeouts with bounds. Deep-merges nested objects instead of shallow overwrite. Adds ProjectConfig.delegation for README parity.

### Patch Changes

- 96cf36b: Enforce type-specific vote thresholds, contain evidence roots, fail closed on Pi spawn fallback, and lock cycle journals against concurrent writers.
- f8d6167: Fix FileDaoStateRepository persistence: atomic tmp+rename writes and serialized intra-process queue. Prevents partial state.json on crash, matching legacy writeAtomic behavior.
- 9eee0bf: FileDaoStateRepository: inter-process file lock (state.lock with stale cleanup) and fail-fast concurrent-modification detection. persist() no longer silently overwrites proposals persisted by another writer — it throws and asks to reopen and retry.
- 6487091: Remove unused AGENT_CHARTER import in governance/agents (lint correctness, no behavior change).
- 0a96294: persistence: skip lock, concurrency check and I/O when persist() has nothing to write, and skip the JSON.parse of state.json when the on-disk bytes match what this instance last read or wrote. Removes the redundant per-persist mkdir in the lock path. Cuts the per-persist cost added by the inter-process lock (9eee0bf), especially for unchanged-state persists.

## 0.16.3

### Patch Changes

- 3de7da2: Blocked anchor status: an anchor whose verification command could not run to a verdict (runner timeout kill, sandbox launch refusal, missing binary) is now recorded as `blocked` instead of `failed` — measured failures and unmeasured environments are no longer conflated. Any `blocked` required anchor routes `EVALUATE` to the cycle's `blocked` terminal (before drift adjustment and retrying), and the series halts (`CYCLE_BLOCKED` → `halted`) for a human restart, so retries are never burned against a broken environment. Implemented through the owner-approved improvement-loop model (graph run `anchor-blocked-status`, model hash `25b3e39cf2ed033de90230b69ef8cc40dc3898eae99ac862963a5c5f1f2d439a`, state `succeeded`). Closes #145.

## 0.16.2

### Patch Changes

- 76f8e01: Two governance/quality fixes from the dogfood series.

  **#141 — a gate failure no longer creates a final zombie.** A red-zone proposal checked without the mandatory dry-run dispatched `CONTROL_FAIL` into the final `failed` state: no re-check (even after completing the dry-run), no rejection, no annotation — only a duplicate proposal could move forward. Now `dao_control` refuses red-zone proposals without a completed dry-run _before_ any transition ("run dao_dry_run proposalId=N first; no state change was made — the proposal stays approved"), and `failed` is no longer lifecycle-final: it carries exactly one closure transition, `REJECT → rejected`, so even a dead proposal gets an auditable reason. `executed`/`rejected` remain the only final statuses.

  **#142 — optional metric contract.** `.dao/improvement.json` now accepts a `metric` section (`name` + `prompt`, optional `evidence`); when present, the sensor/counter-sensor prompts embed it verbatim so paired samples measure the same declared quantity across workers and cycles instead of each worker inventing its own "obvious" scope metric (which made arbitration decisions meaningless). A half-declared contract (name without prompt) fails config validation.

## 0.16.1

### Patch Changes

- 00c84a1: `/dao execute` now hands the work to the session agent instead of silently doing nothing. Two compounding defects: (1) the pi slash-command path rendered the execution result in a UI panel that never reaches the session LLM, so `dao_execute` marked the proposal `executed` and nobody implemented anything; (2) the result text named only a branch, never the isolated workspace path, so the agent could not know where to work. `ExecuteProposalUseCase` now returns the workspace path, `presentExecution` renders it with an explicit begin-implementation directive (workspace, branch, plan, ship step), and the pi `/dao` dispatcher injects execute results into the conversation (`pi.sendMessage`, triggerTurn) so implementation starts immediately. Also stops `/dao rollback` from reporting a rollback that never happened: the use case performs no git operations and the execution snapshot carries no recoverable commit, so it now refuses with the manual-restore path instead of a false "Rollback Successful".

## 0.16.0

### Minor Changes

- 5be1c48: The CLI detects the terminal multiplexer it runs inside and behaves accordingly. `HERDR_ENV=1` → herdr parent session, `TMUX` → tmux parent session, bare shell → herdr default. The multi-agent flows (`deliberate`, `roundtable`, `implement`) resolve their child-session host via a new `--host <herdr|tmux|auto>` flag (`auto` follows detection): inside tmux the children become tmux sessions running the operator-owned `tmux.command` from a new typed `tmux` section of `.dao/config.json` (fail-fast with setup guidance when unset), and the attach hint matches the host (`herdr` / `tmux attach -t <session>`). Child names are previewed with the exact names each host creates.

## 0.15.0

### Minor Changes

- e536a70: Security hardening for GitHub code scanning alerts (all 31 open alerts resolved).

  **Shell-command construction (12 alerts):** every adapter runner now spawns commands as ARGV via `execFile` — the JS side never builds a shell command line, so prompts, labels, series ids and paths can never be shell-interpreted. `HerdrRunner.exec`, `TmuxRunner.exec` and `SandboxExecRunner` take `argv: readonly string[]`; `buildSandboxCommand` (shell-string builder) is replaced by `buildSandboxArgv` (the anchored command still runs through `sh -c` inside the container, which belongs to the image, not to this process). The tmux pane program remains a deliberate shell program — operator-owned config, single argv element to tmux.

  **Polynomial ReDoS (15 alerts):** all risky regexes rewritten linear — line-oriented section parsing (vote/reasoning extraction, delegation signals, delivery-plan phases and tasks, RICE metrics) with `[ \t]` classes instead of `\s`, no `[\s\S]*?` lookahead alternations; trailing-run trims (`/\n+$/`, `/-+$/`, `/\/+$/`) replaced by linear scans. Behavior preserved, including the echo-shadowing case where the first `## Vote` section carries no vote word.

  **Workflow permissions (2 alerts):** `ci.yml` declares `permissions: contents: read`.

## 0.14.0

### Minor Changes

- 3f6f71d: herdr child sessions by default for every multi-agent CLI flow. The new `swarm-dao deliberate <id>` makes every agent vote as a real coding agent in its own herdr child session, `swarm-dao roundtable` does the same for proposal ideas, and `swarm-dao implement <id> [<id>…]` dispatches one herdr child agent per proposal — multiple ids develop in parallel, each in its own execution worktree (requires `execution.isolation`). The CLI process is the parent session that pilots the children; attach with `herdr` to watch any child live. Kind and harvest options default from a new typed `herdr` section in `.dao/config.json` (`kind`, `keepPanes`, `timeoutMs`), overridable via `--kind`, `--keep-panes`, `--timeout-ms`. Also exports `herdrAgentName` from the herdr adapter and widens `ExecutionConfig.isolation` to include `"sandbox"` (already supported by GitWorkspace).

### Patch Changes

- 89e2158: Ground round-table agents in real project context. The shared brief now carries recent git commits and a docs listing with raised budgets (README 2400 chars, total 6000), RoundTableUseCase appends already-tracked proposals as an explicit do-not-re-propose list, and the suggestion prompt makes grounding mandatory (cite real files/commits, no generic suggestions).

## 0.13.0

### Minor Changes

- 5ee6b0c: GitHub auth via the `gh` CLI; auditable rejection path; vote preservation; shared project brief.

  - **Breaking (config):** GitHub authentication is delegated to the `gh` CLI — run `gh auth login` once. `dao_config_github` / `swarm-dao github-config` no longer take a `--token`; they store `owner`, `repo` and an `issues` opt-in (track proposal modifications as GitHub issues). `DAO_GITHUB_TOKEN` is no longer read.
  - **New:** `dao_reject` tool and `swarm-dao reject-proposal <id> --reason <text>` — auditable human REJECT/DISCARD for open, deliberating and approved proposals.
  - **Fix:** deliberation merges votes instead of replacing them — human/CLI votes survive, and agents without a `## Vote` section no longer produce fabricated abstentions.
  - **New:** a deterministic project brief (manifest, README, layout, changelog) is built once per deliberation/round table and injected into every participant's prompt.

- fd458db: Agents no longer hardcode a model.

  - Removed `model: z.ai/GLM-5.1` from every agent description (`agents/dao-*.md`, `packages/copilot-adapter/agents/*.agent.md`) and dropped the `DEFAULT_AGENT_MODEL` stamp.
  - The model now resolves at dispatch time: agent override (frontmatter `model`) → DAO config default (`DAOConfig.defaultModel`, overridable in `.dao/config.json`) → parent session / host default. Agents without an explicit model inherit the session's model on hosts that support it.

- b08481c: Agent roster grows to 8 with SwarmForge-style role definitions.

  - All seven default agent prompts rewritten in an owns / review-method / rules / does-not-own structure (inspired by unclebob/swarm-forge roles): sharper ownership boundaries, structured review phases, and evidence rules per role.
  - **New default agent: UX/UI Designer** (`designer`, weight 2) — UX/UI critique and improvement directions across the four surface modes (Persuade / Operate / Read / Experience), accessibility review (WCAG AA as defects), and design-direction output. Uses the impeccable harness lenses (impeccable.style) when the host provides it, and the Mobbin MCP server as optional design-reference material (requires a subscription).
  - Per-agent tooling declarations: `tools` frontmatter field in `dao-*.md` is now parsed; the Architect declares `sequential-thinking` (structured step-by-step review), Delivery declares `context7` (library API verification), Designer declares `impeccable` + `mobbin`. Agents degrade gracefully when a tool is not configured by the host.
  - `dao_setup` now seeds 8 agents (new DAOs only; existing DAO state is unchanged).

## 0.12.1

### Patch Changes

- 97083c0: CLI operator experience: human gates get dedicated commands, status becomes human-readable.

  - New gate commands replace hand-written JSON signal files (each shows the exact decision inputs and requires confirmation; `--yes` for reviewed non-interactive use): `approve`/`reject` (graph MODEL_APPROVED/MODEL_REJECTED with the exact model hash), `improve retry` (RETRY_AUTHORIZED), `improve retry-workers`, `improve restart`, `improve cancel --reason`, `improve reference --decision approve|reject` (adjusting cycles).
  - `improve status` and `graph status` render human-readable output by default (state glyphs, hashes, anchors, suggested next command); `--json` keeps the raw machine snapshot.
  - `improve cycles --series-id` lists the cycle history (outcome, attempt, metric, drift, arbitration, duration from the journal).
  - `next` shows what the machines need from you now: pending human gates with runnable commands, plus live workflows (cooldown countdowns, in-flight runs).
  - Evidence roots resolve across `.dao/*` and `evidence/*` for reads (a started series beats a stale idle snapshot materialized by an unrooted `improve status`), killing silent `idle` answers; creation effects keep the strict root.
  - Attention suggestions now point at the new gate commands.

## 0.12.0

### Minor Changes

- 1538199: Anchor results are immutable within the current attempt and refreshable across an authorized retry (Graph Engineering run `anchor-retry-refresh`, model hash 179b3a29, human-approved).

  - Machine (`recordAnchorOnce`): an anchor recorded at an earlier attempt is re-recorded when its command runs again at the current attempt; same-attempt duplicates stay rejected. A surviving anchor retained in a failed state no longer dead-ends every retry (dogfood-003 c7: an infra-failed `frozen-set-intact` survived each retry and could never be re-recorded).
  - Executor: grounding skips anchors already recorded at the current attempt (crash-resume idempotency — a re-entered grounding run no longer re-runs and throws on immutable results) and re-runs retained ones.
  - Model docs: `models/improvement-loop.md` anchor rules updated; the gap is closed in `improvement-loop.review.md`.
  - Repairs the `graph:*` and `product:*` CLI shims (re-export does not bind a local name for `import.meta.main`; `graph:init` had never run since the packages move).

## 0.11.4

### Patch Changes

- e073b9a: `advanceSeriesOnce` (and the `dao_improve_once` tools on MCP, Pi and OpenCode) accepts an optional cycle evidence root, mirroring the CLI's `--cycle-root`. Series that live under `evidence/improvement-series` can now keep their cycles under `evidence/improvement-cycles` instead of splitting across roots. The CLI test that polluted the repo's real evidence roots with a stray `nope` snapshot now uses a temp directory.

## 0.11.3

### Patch Changes

- 184216d: Expose `dao_improve_once` and the workflow-run surface to every AI host.

  - New `dao_improve_once` tool (MCP + Pi + OpenCode): advances a series by exactly one state-authorized effect through `advanceSeriesOnce` (new improvement export). The host supplies only the series id — the execution environment comes from the persisted `.dao/improvement.json` configuration and workers/anchors run inside the per-series worktree, so an AI host can pull the trigger but never aim it. Human-decision, worker-failed, halted and terminal states are no-ops.
  - Remaining hosts now expose the workflow-run surface: OpenCode gets `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status`, `dao_improve_once` natively; Claude gets generated `/dao:*` slash commands; Codex and Copilot receive the tools through the shared MCP server. The registry entries carry the full AI host set.

## 0.11.2

### Patch Changes

- 394fd06: Expose the workflow-run surface to AI hosts end to end.

  - New `dao_improve_status` tool (MCP + Pi): read-only improvement series snapshot — state, scope, cooldown, pending reason.
  - New Pi tools: `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status` (also reachable as `/dao` subcommands).
  - The graph and product packages now export AI-channel submission helpers (`submitAiGraphSignal`, `submitAiProductSignal`) that force `source: "ai"` and restrict event types at the type level; the MCP server uses them instead of building signals itself, so the authority boundary lives inside the packages rather than in host convention.

## 0.11.1

### Patch Changes

- 42971b0: Add the read-only `dao_attention` MCP tool: pending human gates across Graph Engineering runs, improvement cycles and series, and product loops, each with its runnable resolution suggestion. The `attention` command registry entry becomes a dual-host (`cli`, `mcp`) command bound to the `dao_attention` tool.

## 0.11.0

### Minor Changes

- a947880: `swarm-dao attention` (and every host reusing `FsAttentionStore`) now also sweeps the CLI-default project roots (`.dao/graph-runs`, `.dao/improvement-cycles`, `.dao/product-loops`) alongside the documented `evidence/` roots, so foreign projects that keep all state under `.dao/` finally surface their pending human gates. A runId present in both roots resolves to the documented root's snapshot. Suggested graph/product resolution commands now use the `swarm-dao` CLI form, which works in any project.
- 1e33d15: `swarm-dao attention` gains an `improvement-series` source: series parked in `workerFailed` (RETRY_WORKERS pending) or `halted` (RESTART_SERIES / CANCEL_SERIES pending) now surface with the pending reason and a runnable `swarm-dao improve submit --series-id …` suggestion. Series evidence is swept from `evidence/improvement-series` and `.dao/improvement-series`. `awaitingHumanCycleDecision` is deliberately not a series gate — the human decision lives on the cycle and is already surfaced by the `improvement-loop` source.

## 0.10.3

### Patch Changes

- 006f8db: Expose Graph Engineering and product-loop runs to MCP hosts: `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`. The host hardcodes `source: "ai"` on every submitted signal and only AI-artifact event types are accepted — human events (approvals, rejections, retries, cancellations) stay on the `swarm-dao` CLI human channel. The command registry declares the four new MCP-host commands (mutating submits bound to deterministic tools).

## 0.10.2

### Patch Changes

- dfb8fd5: Declare the new CLI-only commands `graph` and `product` in the DAO command registry (run surfaces for the Graph Engineering and product-loop executors).

## 0.10.1

### Patch Changes

- ee994e1: `/dao <subcommand>` now executes instead of routing: Pi slash commands cannot invoke Pi tools, but the adapter owns both surfaces, so every registry command (propose, deliberate, check, execute, ship, rollback, plan, artefacts, dry-run, roundtable, rate, update-proposal, check-edit, github-\*) now runs its tool logic inline and renders the result. Quote-aware argument parsing supports ids, titles, flags (`--cascade`, `--force`, `--token/owner/repo`, …) and usage messages on invalid input. Also fixes `dao_github_create_branch` / `dao_github_open_pr` reporting "GitHub not configured" immediately after a successful `dao_config_github` in the same session: the in-memory token is now reused when the persisted token is redacted and `DAO_GITHUB_TOKEN` is unset (same owner/repo only).

## 0.10.0

### Minor Changes

- 82df3ed: ADR-003 accepted: sandboxed proposal execution. `planExecutionIsolation` and `createExecutionWorkspace` accept `execution.isolation: "sandbox"` (worktree + bounded container: runtime probed before provisioning, network disabled, CPU/memory capped, image strictly validated) next to `worktree`; the pure container command builder moves to core delivery (`buildSandboxCommand`, `validateSandboxImage`) and the improvement package reuses it. Env-gated integration test (`EVOLUTION_IT=1`) proves a trivial evolution lands in the sandboxed worktree.

## 0.9.0

### Minor Changes

- 08a8b29: Improvement loop everywhere: new `@guyghost/swarm-dao-improvement` executor package (series orchestrator, cycle runner, herdr workers, per-project `.dao/improvement.json` anchor config) and `swarm-dao improve init|status|once|submit` CLI commands to run improvement series in any project. Anchor commands can execute in a bounded sandbox (`--sandbox docker|container|auto|none --image <ref>`: network off, repo mounted at /workspace, CPU/memory caps) via Docker or Apple container. Core gains the `models/improvement` export subpath and the `improve` registry entry.

### Patch Changes

- 774bc5d: Improvement loop arbitration: the counter-veto now keys on a frozen negative-outcome set (`declined`, `fell`) instead of the single string `declined`. The veto stays prompt-vocabulary independent — a sensor phrasing drift (found by dogfood-002) can no longer silently disarm it. Outcome strings are unchanged, so journal replay stays deterministic. Governed by Graph Engineering run `ge-arbitration-vocabulary` (model hash `417bfd8b…`).

## 0.8.0

### Minor Changes

- 7469a87: Add the improvement orchestrator: a separately modelled continuous series that runs repeated improvement loop cycles on a fixed scope and reference. It ships the series state machine (`improvement-orchestrator.machine.ts`), the reviewed model (`models/improvement-orchestrator.*`), a herdr worker executor, and a series CLI (`improvement:series:init|status|submit|once`). The orchestrator is correlation plus effect execution only — it never owns cycle state and pauses on the same human gates as the cycles it runs.

## 0.7.0

### Minor Changes

- 886824e: Health-score weights consistency across every dashboard surface. `generateDashboard` accepts an optional `weights` argument (default `DEFAULT_HEALTH_WEIGHTS`, backward compatible) and passes it to `computeHealthScore` — previously its Overview score always used default weights while the appended `formatHealthScore` used `config.healthWeights`, displaying two conflicting scores under custom weights. The core host-tools `handleDaoDashboard` handler and the opencode adapter now pass `state.config.healthWeights` so the pi tool, the `/dao` command, opencode, and MCP surfaces all agree. These changes shipped in #71 but were missing a core/opencode changeset at the time; this releases them (npm core 0.6.0 predates the weights parameter).

## 0.6.0

### Minor Changes

- 20a76a2: Add the opt-in ship audit challenge (swarm-forge's AUDIT_REQUIRED adapted to shipping): with `ship.auditChallenge: true` in `.dao/config.json`, the first `dao_ship`/`swarm-dao ship` call returns `AUDIT_REQUIRED` instead of executing; only an unchanged second call executes, bound to a deterministic fingerprint of the decision content (votes, gates, scope). Any change re-issues the challenge; a confirmation is single-use (spent on one execution attempt); `--force` is an explicit, recorded human bypass. Pure `ship-audit.machine.ts` (no AI role — confirmation is a deterministic property of two identical requests), an `FsShipAuditStore` under `.dao/ship-audits/`, wired into the host ship handler and the CLI. Gated through the Graph Engineering change-control ceremony (run `ship-audit-1`, model hash approved by the owner). Anchors: `shipaudit:validate`, `shipaudit:demo`, `shipaudit:regression`.

## 0.5.0

### Minor Changes

- 1c20921: Add opt-in sequential (pipeline) deliberation: `deliberation.strategy: "sequential"` in `.dao/config.json` runs agents in registry order, one at a time, each receiving a `## Prior Analyses` section built from the agents before it — analyses only (`extractAnalysis` strips everything from the `## Vote` heading on) and capped at `charsPerAgent` characters (default 1500), so the deterministic tally keeps its independence. Failed spawns record error outputs and the pipeline continues. Manual hosts get the pipeline protocol in the dispatch plan. Parallel remains the default; no proposal states, transitions, or AI boundaries change.
- ecfa79a: Add opt-in execution isolation via git worktrees. When `execution.isolation` is `"worktree"` in `.dao/config.json`, executing a proposal first provisions a dedicated worktree (branch `dao/<id>-<slug>` under `.dao/worktrees`), the execution snapshot and audit record the real branch, and merging back stays a separate deliberate action. Includes: pure `planExecutionIsolation`, an `ExecutionWorkspacePort` injected into ExecuteProposalUseCase/ShipProposalUseCase, a `GitWorkspace` adapter (idempotent retry, branch-exists fallback) wired into `dao_execute` on every host and `swarm-dao ship` on the CLI. A failed preparation leaves the proposal `controlled`.
- 831a124: Layer the agent prompts as a constitution (swarm-forge pattern): every agent's system prompt is now composed from a shared `AGENT_CHARTER` (deliberation conduct + the exact parseable output format, defined once instead of duplicated across all seven prompts), a role layer (the agent's mission — the markdown body of `dao-<id>.md` now replaces the default role prompt, consistent with frontmatter overriding name/role/model/weight), and an optional per-project `charter.md` addendum appended to every agent. Layers only add; the shared charter is never replaceable. Composition is pure, deterministic, happens exactly once at the load exits, and the markdown-merge cache now tracks `charter.md` too.
- ecd1d32: Add a read-only attention queue: `collectAttention` / `classifyAttention` / `formatAttention` in observability, an `FsAttentionStore` filesystem adapter, an `attention` CLI-only registry command, and the `swarm-dao attention [--source ...]` CLI command. The sweep aggregates pending human decisions across Graph Engineering runs (`awaitingApproval`, `retrying`), Improvement Loop cycles (`adjusting`, `retrying`), and Product Loop runs (`review`) from the persisted evidence snapshots. It never sends events, never mutates machine state, and skips unreadable runs.
- 34fa76e: Wire the `mode` and `criticalPaths` configuration into a deterministic edit gate: `dao_check_edit` (exposed on MCP, Copilot/Claude/Codex adapters, Pi, and OpenCode) lets agents check the files they are about to touch before editing. `opt-in` flags critical paths informationally, `suggest` adds a non-blocking proposal nudge on uncovered critical paths, and `enforce` blocks critical paths unless an approved, controlled, or executed proposal declares them in `affectedPaths`. The gate is pure and read-only — it never edits files and never transitions proposal state. Previously `mode` and `criticalPaths` were documented as reserved schema with no host wiring.

### Patch Changes

- eb686bd: Fix package exports: add the `./adapters`, `./ports`, and `./delivery/artefacts` subpaths that integration tests and benchmarks consume. Without them, any external consumer importing these subpaths fails to resolve.
- c561bb7: Expose the GitHub integration on the Pi extension and the OpenCode plugin: `dao_config_github`, `dao_github_create_branch`, and `dao_github_open_pr` are now registered as native tools on both hosts (previously CLI + MCP only). The registry entries list `pi` and `opencode`, and the three host-tool handlers now read state through the context repository instead of the process-global legacy bridge.

## 0.4.0

### Minor Changes

- 7525259: Remove the redundant per-proposal sidecar files

  Proposals were persisted twice: once in `state.json` (the authoritative state)
  and again as standalone `.dao/proposals/NNN.json` "sidecar" files. The sidecar
  layer is removed so `state.json` is the single source of truth for proposals.

  `saveState()` no longer writes or reconciles per-proposal files, and
  `loadState()` no longer merges sidecars back into state. On the first load
  after upgrading, any existing sidecars whose proposal id is missing from
  `state.json` are imported, then the now-dead `proposals/` directory is removed.

  The removed functions `loadProposalsFromDisk`, `saveProposal`, `getProposalPath`,
  and `getProposalsDir` were internal helpers not re-exported from the package
  barrel, so this is storage-internal with no public API change. The
  `security_fix.test.ts` suite (which tested `loadProposalsFromDisk` log safety)
  has been removed with it.

### Patch Changes

- 8b232e9: Core performance optimizations across handlers, governance, persistence and HTTP

  A set of internal hot-path optimizations with no public API changes. On-disk
  state and observable behavior are unchanged; only redundant work is removed.

  - Governance handlers: dropped redundant trailing `saveState()` after
    `recordAudit` (which persists internally) in the propose/execute/amend paths.
    The round table now appends audit entries in memory and persists them in a
    single trailing save instead of one full save per proposal (O(k) -> O(1)).
  - Deliberation/round-table dispatch: resolve agents through a lookup `Map`
    built once per batch instead of a per-iteration `find()` scan.
  - Agent definitions: `loadAgentDefinitions` results are cached per agents
    directory and validated by a file-stat signature, so `dao-*.md` files are not
    re-read from disk on every `dao_deliberate` / `dao_roundtable` call.
  - Dependency resolver: build the proposal `Map` once in
    `resolveDependencyOrder` / `getUnexecutedDependencies` and reuse it instead
    of rebuilding it per proposal during the DFS traversal.
  - Error redaction: the sensitive-key regexes in `sanitizeErrorMessage` are now
    compiled once at module load and reused, instead of being rebuilt on every
    call (byte-identical redaction output).
  - Scoring parser: `parseScoresFromOutput` makes a single `matchAll` pass over
    the agent output instead of running one regex per scoring axis; composite
    averaging uses a single reduce. Parsing results are unchanged.
  - HTTP client: add retry with exponential backoff + jitter for transient
    failures (network errors, 429, 5xx), honoring `Retry-After` with a sane cap,
    while never retrying definitive 4xx. A per-instance fetch injection seam is
    added for testability with zero production behavior change.

- ed98280: Persistence: skip rewriting unchanged JSON files in saveState()

  `saveState()` now caches the last serialized content per file path and skips the
  disk write when the content is unchanged. Previously every mutation (adding a
  vote, storing an agent output, recording audit, storing a score/synthesis/plan)
  rewrote `state.json` plus every proposal sidecar and every decision file — even
  the ones that did not change. On the deliberation hot path, which triggers a
  save ~6 times back-to-back, this removes the bulk of the redundant file writes
  while keeping the on-disk bytes identical.

## 0.3.0

### Minor Changes

- 8e91a15: Add MCP foundation and three host plugins (Copilot, Claude, Codex).

  - **core**: reconstruct the shared `host-tools` handler layer as TypeScript
    source (messages, utils, github-config, handlers) and export it from the
    package barrel.
  - **mcp-server** (new): expose the full Swarm DAO toolset (23 tools) as a
    stdio MCP server, built on the shared handler layer. Manual deliberation
    mode (`dao_deliberate` → spawn sub-agents → `dao_record_outputs`).
  - **copilot-adapter** (new): GitHub Copilot plugin — `swarm-dao-copilot` bin,
    `.vscode/mcp.json`, `copilot-instructions.md`, `HostAdapter`.
  - **claude-adapter** (new): Claude Code plugin — `swarm-dao-claude` bin,
    `.mcp.json`, `CLAUDE.md`, slash commands (`/dao-propose`, `/dao-deliberate`,
    `/dao-ship`), `HostAdapter`.
  - **codex-adapter** (new): OpenAI Codex plugin — `swarm-dao-codex` bin,
    `config.toml` snippet, `AGENTS.md`, `HostAdapter`.

## 0.2.0

### Minor Changes

- Release 0.2.0 — model resolution, lifecycle hardening, security, and CI reliability.

  - Add XState state machine for proposal lifecycle management
  - Inherit model resolution when spawning DAO agents (agent override → parent session → DAO default → host default)
  - Harden security: secret redaction in config and logs, path traversal protection, sanitized persistence errors
  - Replace proposal type magic strings with typed constants
  - Add Husky pre-push hook and `bun run ci` script mirroring GitHub Actions
  - Pin Bun version in CI workflows and align publish workflow with lint gate
  - Update dependencies and documentation

## 0.1.4

### Patch Changes

- Patch release for recent improvements across the core package and adapters.

## 0.1.2

### Patch Changes

- Prepare a new patch release for all published Swarm DAO packages.

## 0.1.1

### Patch Changes

- 66b061b: Initial release of Swarm DAO — unified AI agent governance with 4-layer architecture (Governance → Intelligence → Control → Delivery) and 7 default agents. Includes Pi adapter, OpenCode adapter, and standalone CLI.
