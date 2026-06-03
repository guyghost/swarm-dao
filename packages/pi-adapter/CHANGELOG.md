# @guyghost/swarm-dao-pi-adapter

## 0.1.1

### Patch Changes

- 4574559: Prepare adapters for platform release

  - Improved type definitions with comprehensive JSDoc for both OpenCode and Pi adapters
  - Added complete README.md documentation for both packages
  - Enhanced package.json metadata (keywords, sideEffects, peerDependenciesMeta)
  - Fixed type safety: narrowed `any` types to proper interfaces (Vote[], AmendmentPayload)
  - Fixed Pi hasCapability to not report spawn_agent as available when stubbed
  - Fixed Pi README installation instructions to avoid redundant dependencies
  - Added static import for addRating instead of dynamic import
  - Resolved ambient type leakage in Pi type stubs

- 66b061b: Initial release of Swarm DAO — unified AI agent governance with 4-layer architecture (Governance → Intelligence → Control → Delivery) and 7 default agents. Includes Pi adapter, OpenCode adapter, and standalone CLI.
- Updated dependencies [66b061b]
  - @guyghost/swarm-dao-core@0.1.1
