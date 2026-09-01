# @guyghost/swarm-dao-core

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
