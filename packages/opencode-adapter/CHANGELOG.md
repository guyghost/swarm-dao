# @guyghost/swarm-dao-opencode-adapter

## 0.5.0

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

### Patch Changes

- Updated dependencies [5ee6b0c]
- Updated dependencies [fd458db]
- Updated dependencies [b08481c]
  - @guyghost/swarm-dao-core@0.13.0
  - @guyghost/swarm-dao-graph@0.3.2
  - @guyghost/swarm-dao-improvement@0.5.5
  - @guyghost/swarm-dao-product@0.3.2

## 0.4.3

### Patch Changes

- Updated dependencies [1538199]
  - @guyghost/swarm-dao-core@0.12.0
  - @guyghost/swarm-dao-improvement@0.5.3
  - @guyghost/swarm-dao-graph@0.3.1
  - @guyghost/swarm-dao-product@0.3.1

## 0.4.2

### Patch Changes

- 326c1f4: Post-dogfood hardening (dogfood-003 cycle 6 findings):

  - Worker retries now close herdr workspaces left behind by a run killed mid-flight (host timeout, crash) before carving a fresh one — deterministic labels make lingering same-label workspaces orphans, so retries converge instead of accumulating panes.
  - `dao_improve_once` tool descriptions and the MCP README now state that worker phases take minutes and hosts must raise their request timeout (MCP clients default to 60s and kill the call mid-flight).

- Updated dependencies [326c1f4]
  - @guyghost/swarm-dao-improvement@0.5.1

## 0.4.1

### Patch Changes

- e073b9a: `advanceSeriesOnce` (and the `dao_improve_once` tools on MCP, Pi and OpenCode) accepts an optional cycle evidence root, mirroring the CLI's `--cycle-root`. Series that live under `evidence/improvement-series` can now keep their cycles under `evidence/improvement-cycles` instead of splitting across roots. The CLI test that polluted the repo's real evidence roots with a stray `nope` snapshot now uses a temp directory.
- Updated dependencies [e073b9a]
  - @guyghost/swarm-dao-improvement@0.5.0
  - @guyghost/swarm-dao-core@0.11.4

## 0.4.0

### Minor Changes

- 184216d: Expose `dao_improve_once` and the workflow-run surface to every AI host.

  - New `dao_improve_once` tool (MCP + Pi + OpenCode): advances a series by exactly one state-authorized effect through `advanceSeriesOnce` (new improvement export). The host supplies only the series id — the execution environment comes from the persisted `.dao/improvement.json` configuration and workers/anchors run inside the per-series worktree, so an AI host can pull the trigger but never aim it. Human-decision, worker-failed, halted and terminal states are no-ops.
  - Remaining hosts now expose the workflow-run surface: OpenCode gets `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status`, `dao_improve_once` natively; Claude gets generated `/dao:*` slash commands; Codex and Copilot receive the tools through the shared MCP server. The registry entries carry the full AI host set.

### Patch Changes

- Updated dependencies [184216d]
  - @guyghost/swarm-dao-improvement@0.4.0
  - @guyghost/swarm-dao-core@0.11.3

## 0.3.6

### Patch Changes

- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0

## 0.3.5

### Patch Changes

- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0

## 0.3.4

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0

## 0.3.2

### Patch Changes

- 886824e: Health-score weights consistency across every dashboard surface. `generateDashboard` accepts an optional `weights` argument (default `DEFAULT_HEALTH_WEIGHTS`, backward compatible) and passes it to `computeHealthScore` — previously its Overview score always used default weights while the appended `formatHealthScore` used `config.healthWeights`, displaying two conflicting scores under custom weights. The core host-tools `handleDaoDashboard` handler and the opencode adapter now pass `state.config.healthWeights` so the pi tool, the `/dao` command, opencode, and MCP surfaces all agree. These changes shipped in #71 but were missing a core/opencode changeset at the time; this releases them (npm core 0.6.0 predates the weights parameter).
- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [20a76a2]
  - @guyghost/swarm-dao-core@0.6.0

## 0.3.0

### Minor Changes

- 34fa76e: Wire the `mode` and `criticalPaths` configuration into a deterministic edit gate: `dao_check_edit` (exposed on MCP, Copilot/Claude/Codex adapters, Pi, and OpenCode) lets agents check the files they are about to touch before editing. `opt-in` flags critical paths informationally, `suggest` adds a non-blocking proposal nudge on uncovered critical paths, and `enforce` blocks critical paths unless an approved, controlled, or executed proposal declares them in `affectedPaths`. The gate is pure and read-only — it never edits files and never transitions proposal state. Previously `mode` and `criticalPaths` were documented as reserved schema with no host wiring.
- c561bb7: Expose the GitHub integration on the Pi extension and the OpenCode plugin: `dao_config_github`, `dao_github_create_branch`, and `dao_github_open_pr` are now registered as native tools on both hosts (previously CLI + MCP only). The registry entries list `pi` and `opencode`, and the three host-tool handlers now read state through the context repository instead of the process-global legacy bridge.

### Patch Changes

- Updated dependencies [1c20921]
- Updated dependencies [eb686bd]
- Updated dependencies [ecfa79a]
- Updated dependencies [831a124]
- Updated dependencies [ecd1d32]
- Updated dependencies [34fa76e]
- Updated dependencies [c561bb7]
  - @guyghost/swarm-dao-core@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [8b232e9]
- Updated dependencies [ed98280]
- Updated dependencies [7525259]
  - @guyghost/swarm-dao-core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [8e91a15]
  - @guyghost/swarm-dao-core@0.3.0

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

### Patch Changes

- Updated dependencies
  - @guyghost/swarm-dao-core@0.2.0

## 0.1.4

### Patch Changes

- Patch release for recent improvements across the core package and adapters.
- Updated dependencies
  - @guyghost/swarm-dao-core@0.1.4

## 0.1.2

### Patch Changes

- Prepare a new patch release for all published Swarm DAO packages.
- Updated dependencies
  - @guyghost/swarm-dao-core@0.1.2

## 0.1.1

### Patch Changes

- 4574559: Prepare adapters for platform release

  - Improved type definitions with comprehensive JSDoc for the OpenCode adapter
  - Added complete README.md documentation for this package
  - Enhanced package.json metadata (keywords, sideEffects, peerDependenciesMeta)
  - Fixed type safety: narrowed `any` types to proper interfaces (Vote[], AmendmentPayload)
  - Fixed hasCapability to not report spawn_agent as available when stubbed
  - Fixed README installation instructions to avoid redundant dependencies
  - Added static import for addRating instead of dynamic import
  - Resolved ambient type leakage in OpenCode type stubs

- 66b061b: Initial release of Swarm DAO — unified AI agent governance with 4-layer architecture (Governance → Intelligence → Control → Delivery) and 7 default agents. Includes the OpenCode adapter and standalone CLI support.
- Updated dependencies [66b061b]
  - @guyghost/swarm-dao-core@0.1.1
