# @guyghost/swarm-dao-cli

## 0.4.1

### Patch Changes

- 1e33d15: `swarm-dao attention` gains an `improvement-series` source: series parked in `workerFailed` (RETRY_WORKERS pending) or `halted` (RESTART_SERIES / CANCEL_SERIES pending) now surface with the pending reason and a runnable `swarm-dao improve submit --series-id …` suggestion. Series evidence is swept from `evidence/improvement-series` and `.dao/improvement-series`. `awaitingHumanCycleDecision` is deliberately not a series gate — the human decision lives on the cycle and is already surfaced by the `improvement-loop` source.
- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0
  - @guyghost/swarm-dao-graph@0.2.1
  - @guyghost/swarm-dao-improvement@0.3.1
  - @guyghost/swarm-dao-product@0.2.1

## 0.4.0

### Minor Changes

- 1b210ea: `improve once` gains `--exec branch|worktree|container` (where the series runs: current checkout, an isolated per-series git worktree, or anchor commands in a bounded container) and `--agent <kind>` / `--agent-args` (which herdr agent executable runs the workers — pi, codex, claude, …; also configurable via `worker` in `.dao/improvement.json`).
- aaa716e: Add `swarm-dao graph <init|status|submit>` — Graph Engineering change-control runs in any project (evidence under `.dao/graph-runs` by default), alongside the existing `improve` loop commands.
- 90ba1f4: Add `swarm-dao product <init|status|submit>` — product-loop runs in any project (evidence under `.dao/product-loops` by default), completing the CLI trio: DAO proposals, Graph Engineering runs, product loops, and improvement series.

### Patch Changes

- Updated dependencies [dfb8fd5]
- Updated dependencies [aaa716e]
- Updated dependencies [1b210ea]
- Updated dependencies [90ba1f4]
  - @guyghost/swarm-dao-core@0.10.2
  - @guyghost/swarm-dao-graph@0.2.0
  - @guyghost/swarm-dao-improvement@0.3.0
  - @guyghost/swarm-dao-product@0.2.0

## 0.3.1

### Patch Changes

- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0
  - @guyghost/swarm-dao-improvement@0.2.1

## 0.3.0

### Minor Changes

- 08a8b29: Improvement loop everywhere: new `@guyghost/swarm-dao-improvement` executor package (series orchestrator, cycle runner, herdr workers, per-project `.dao/improvement.json` anchor config) and `swarm-dao improve init|status|once|submit` CLI commands to run improvement series in any project. Anchor commands can execute in a bounded sandbox (`--sandbox docker|container|auto|none --image <ref>`: network off, repo mounted at /workspace, CPU/memory caps) via Docker or Apple container. Core gains the `models/improvement` export subpath and the `improve` registry entry.

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0
  - @guyghost/swarm-dao-improvement@0.2.0

## 0.2.6

### Patch Changes

- Updated dependencies [7469a87]
  - @guyghost/swarm-dao-core@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [886824e]
  - @guyghost/swarm-dao-core@0.7.0

## 0.2.4

### Patch Changes

- 20a76a2: Add the opt-in ship audit challenge (swarm-forge's AUDIT_REQUIRED adapted to shipping): with `ship.auditChallenge: true` in `.dao/config.json`, the first `dao_ship`/`swarm-dao ship` call returns `AUDIT_REQUIRED` instead of executing; only an unchanged second call executes, bound to a deterministic fingerprint of the decision content (votes, gates, scope). Any change re-issues the challenge; a confirmation is single-use (spent on one execution attempt); `--force` is an explicit, recorded human bypass. Pure `ship-audit.machine.ts` (no AI role — confirmation is a deterministic property of two identical requests), an `FsShipAuditStore` under `.dao/ship-audits/`, wired into the host ship handler and the CLI. Gated through the Graph Engineering change-control ceremony (run `ship-audit-1`, model hash approved by the owner). Anchors: `shipaudit:validate`, `shipaudit:demo`, `shipaudit:regression`.
- Updated dependencies [20a76a2]
  - @guyghost/swarm-dao-core@0.6.0

## 0.2.3

### Patch Changes

- ecfa79a: Add opt-in execution isolation via git worktrees. When `execution.isolation` is `"worktree"` in `.dao/config.json`, executing a proposal first provisions a dedicated worktree (branch `dao/<id>-<slug>` under `.dao/worktrees`), the execution snapshot and audit record the real branch, and merging back stays a separate deliberate action. Includes: pure `planExecutionIsolation`, an `ExecutionWorkspacePort` injected into ExecuteProposalUseCase/ShipProposalUseCase, a `GitWorkspace` adapter (idempotent retry, branch-exists fallback) wired into `dao_execute` on every host and `swarm-dao ship` on the CLI. A failed preparation leaves the proposal `controlled`.
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

- 66b061b: Initial release of Swarm DAO — unified AI agent governance with 4-layer architecture (Governance → Intelligence → Control → Delivery) and 7 default agents. Includes Pi adapter, OpenCode adapter, and standalone CLI.
- Updated dependencies [66b061b]
  - @guyghost/swarm-dao-core@0.1.1
