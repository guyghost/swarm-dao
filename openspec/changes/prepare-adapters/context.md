# Context: Prepare Adapters for Target Platforms

## Objective
Prepare the OpenCode and Pi adapters so they are fully usable on their respective target platforms.

## Current State

### OpenCode Adapter (`packages/opencode-adapter/`)
- **Package**: `@guyghost/swarm-dao-opencode-adapter`
- **Target Platform**: OpenCode (`@opencode-ai/plugin`)
- **Peer Dependency**: `@opencode-ai/plugin >=1.14.19`
- **Issues**:
  - `spawnAgent` returns error: "OpenCode agent spawning requires manual dispatch via task tool"
  - `spawnAgents` returns empty array
  - Type definitions in `opencode-types.d.ts` are basic stubs
  - Missing proper plugin manifest/documentation

### Pi Adapter (`packages/pi-adapter/`)
- **Package**: `@guyghost/swarm-dao-pi-adapter`
- **Target Platform**: Pi Coding Agent (`@earendil-works/pi-coding-agent`)
- **Peer Dependencies**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`
- **Issues**:
  - `spawnAgent` returns error: "Pi agent spawning not yet implemented in adapter — use manual deliberation"
  - Type definitions in `pi-types.d.ts` are basic stubs
  - Missing proper extension documentation

## Technical Decisions
| Decision | Justification | Agent |
|----------|---------------|-------|
| Stubs use `any` for external SDK schema builders | Avoids hard dependency on Zod/TypeBox at compile time | @codegen |
| `spawnAgent` returns descriptive error | Platforms don't support automatic agent spawning yet | @codegen |
| Peer dependencies marked as optional | Allows compilation without host SDKs installed | @codegen |
| Pi `hasCapability('spawn_agent')` returns `false` | Implementation is a stub; prevents core logic from being misled | @validator |
| OpenCode `votes` narrowed to `Vote[]` | Better type safety, removes `any` | @validator |

## Artifacts Produced
| File | Agent | Status |
|------|-------|--------|
| `packages/opencode-adapter/src/opencode-types.d.ts` | @codegen | ✅ Improved |
| `packages/opencode-adapter/README.md` | @codegen | ✅ Created |
| `packages/opencode-adapter/package.json` | @codegen | ✅ Improved |
| `packages/pi-adapter/src/pi-types.d.ts` | @codegen | ✅ Improved |
| `packages/pi-adapter/README.md` | @codegen | ✅ Created |
| `packages/pi-adapter/package.json` | @codegen | ✅ Improved |

## Inter-Agent Notes
<!-- Format: [@source → @destination] Message -->
- [@integrator → @codegen] Pi ambient types leaked globally — moved inside `declare module`
- [@validator → @codegen] Pi `hasCapability('spawn_agent')` should return `false`
- [@validator → @codegen] OpenCode `votes: any[]` should be `Vote[]`
- [@review → @codegen] Dynamic import `addRating` should be static
- [@review → @codegen] Pi README still listed `spawn_agent` in capability table

## Verification Results
- `bun run build` (all packages): ✅ Clean
- `bun test` (OpenCode adapter): ✅ 17 pass, 0 fail
- `bun test` (Pi adapter): ✅ 25 pass, 0 fail
- `bun test` (full workspace): ✅ 148 pass, 0 fail
