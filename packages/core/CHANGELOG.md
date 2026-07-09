# @guyghost/swarm-dao-core

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
