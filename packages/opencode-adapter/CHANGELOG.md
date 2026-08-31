# @guyghost/swarm-dao-opencode-adapter

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
