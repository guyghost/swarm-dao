# @guyghost/swarm-dao-product

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
