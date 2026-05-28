---
"@guyghost/swarm-dao-opencode-adapter": patch
"@guyghost/swarm-dao-pi-adapter": patch
---

Prepare adapters for platform release

- Improved type definitions with comprehensive JSDoc for both OpenCode and Pi adapters
- Added complete README.md documentation for both packages
- Enhanced package.json metadata (keywords, sideEffects, peerDependenciesMeta)
- Fixed type safety: narrowed `any` types to proper interfaces (Vote[], AmendmentPayload)
- Fixed Pi hasCapability to not report spawn_agent as available when stubbed
- Fixed Pi README installation instructions to avoid redundant dependencies
- Added static import for addRating instead of dynamic import
- Resolved ambient type leakage in Pi type stubs