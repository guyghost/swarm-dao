# @guyghost/swarm-dao-product

## 0.3.9

### Patch Changes

- 4aa7b9c: Add a repository-native software delivery coordinator that connects Product Loop qualification and budget, exact-hash Graph approval, reversible local staging, observation, and rollback.
  
  Also publish the Product Loop human deploy-authorization signal fix required by the coordinator.
- Updated dependencies [28d24ca]
- Updated dependencies [4443f1a]
- Updated dependencies [2b03f27]
- Updated dependencies [ec03c6f]
- Updated dependencies [e7ef6a2]
- Updated dependencies [4aa7b9c]
- Updated dependencies [f38bea6]
- Updated dependencies [2f510a9]
- Updated dependencies [c3cf299]
  - @guyghost/swarm-dao-core@3.0.0

## 0.3.8

### Patch Changes

- Updated dependencies [b7f55eb]
- Updated dependencies [c20ef3d]
- Updated dependencies [e256fbc]
- Updated dependencies [fd1e0d1]
  - @guyghost/swarm-dao-core@2.0.0

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

- 90ba1f4: Add `@guyghost/swarm-dao-product`: the product-loop run executor (journal-replayed runs, producer-bound signal validation, `runProductCli` entry) previously repo-local under `tools/product-loop`. Behavior is unchanged; `tools/product-loop/*` now re-export from the package.

### Patch Changes

- Updated dependencies [dfb8fd5]
  - @guyghost/swarm-dao-core@0.10.2
