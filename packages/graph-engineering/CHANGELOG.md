# @guyghost/swarm-dao-graph

## 0.4.1

### Patch Changes

- Updated dependencies [b7f55eb]
- Updated dependencies [c20ef3d]
- Updated dependencies [e256fbc]
- Updated dependencies [fd1e0d1]
  - @guyghost/swarm-dao-core@2.0.0

## 0.4.0

### Minor Changes

- 6b7d790: Graph Engineering retries after failed evaluation are now system-owned: EVALUATE / IMPLEMENTATION_FAILED with remaining budget auto-continue to implementing. There is no RETRY_AUTHORIZED human event on a graph run; model-hash approval and cancel stay human.
- 9cc48a9: Wire the classifier verdict into Graph Engineering implementing: the host prepends CLASSIFIER_CHARTER, routes on evaluateAttempt, and only then emits IMPLEMENTATION_READY or IMPLEMENTATION_FAILED.

### Patch Changes

- Updated dependencies [3aa2664]
- Updated dependencies [d722194]
- Updated dependencies [6b7d790]
- Updated dependencies [9cc48a9]
  - @guyghost/swarm-dao-core@1.1.0

## 0.3.7

### Patch Changes

- 4184177: Fix published manifests: internal dependencies were declared with the `workspace:*` protocol, which `npm publish` does not resolve (only pnpm does). Every install of the affected packages failed with `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`. Restore `^` semver ranges, which changesets bumps automatically on release.
- Updated dependencies [527195a]
  - @guyghost/swarm-dao-core@1.0.1

## 0.3.6

### Patch Changes

- 96cf36b: Enforce type-specific vote thresholds, contain evidence roots, fail closed on Pi spawn fallback, and lock cycle journals against concurrent writers.
- Updated dependencies [2da3218]
- Updated dependencies [96cf36b]
- Updated dependencies [f8d6167]
- Updated dependencies [9eee0bf]
- Updated dependencies [6487091]
- Updated dependencies [0a96294]
- Updated dependencies [f8d6167]
- Updated dependencies [72ad3ed]
  - @guyghost/swarm-dao-core@1.0.0

## 0.3.5

### Patch Changes

- Updated dependencies [5be1c48]
  - @guyghost/swarm-dao-core@0.16.0

## 0.3.4

### Patch Changes

- Updated dependencies [e536a70]
  - @guyghost/swarm-dao-core@0.15.0

## 0.3.3

### Patch Changes

- Updated dependencies [3f6f71d]
- Updated dependencies [89e2158]
  - @guyghost/swarm-dao-core@0.14.0

## 0.3.2

### Patch Changes

- Updated dependencies [5ee6b0c]
- Updated dependencies [fd458db]
- Updated dependencies [b08481c]
  - @guyghost/swarm-dao-core@0.13.0

## 0.3.1

### Patch Changes

- Updated dependencies [1538199]
  - @guyghost/swarm-dao-core@0.12.0

## 0.3.0

### Minor Changes

- 394fd06: Expose the workflow-run surface to AI hosts end to end.

  - New `dao_improve_status` tool (MCP + Pi): read-only improvement series snapshot — state, scope, cooldown, pending reason.
  - New Pi tools: `dao_attention`, `dao_graph_status`, `dao_graph_submit`, `dao_product_status`, `dao_product_submit`, `dao_improve_status` (also reachable as `/dao` subcommands).
  - The graph and product packages now export AI-channel submission helpers (`submitAiGraphSignal`, `submitAiProductSignal`) that force `source: "ai"` and restrict event types at the type level; the MCP server uses them instead of building signals itself, so the authority boundary lives inside the packages rather than in host convention.

### Patch Changes

- Updated dependencies [394fd06]
  - @guyghost/swarm-dao-core@0.11.2

## 0.2.1

### Patch Changes

- Updated dependencies [a947880]
- Updated dependencies [1e33d15]
  - @guyghost/swarm-dao-core@0.11.0

## 0.2.0

### Minor Changes

- aaa716e: Add `@guyghost/swarm-dao-graph`: the Graph Engineering run executor (journal-replayed runs, strict signal validation, `runGraphCli` entry) previously repo-local under `tools/graph-engineering`. Behavior is unchanged; `tools/graph-engineering/*` now re-export from the package.

### Patch Changes

- Updated dependencies [dfb8fd5]
  - @guyghost/swarm-dao-core@0.10.2
