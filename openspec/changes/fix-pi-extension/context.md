# Context: Fix Pi Extension & Core Bugs

## Objective
Fix critical runtime errors in swarm-dao that affect the Pi extension, improve test coverage, and resolve build script issues.

## Constraints
- Platform: Node.js / Bun
- Offline first: yes (local file storage)
- Design system: N/A (CLI/extension library)

## Issues Identified

### CRITICAL: `saveDecisions` crashes with `TypeError: undefined is not an object`
**File:** `packages/core/src/persistence.ts`  
**Location:** `saveDecisions()` line 256  
**Cause:** `state.proposals` is undefined when state is loaded from a corrupted or legacy `state.json` that lacks the `proposals` array.

**Impact:** All packages (core, cli, pi-adapter, opencode-adapter) fail when saving state.

**Fix needed:**
- Guard `saveDecisions` against undefined `state.proposals`
- Guard `loadState` to ensure `loaded.proposals` is always an array
- Guard `saveState` sidecar loop against undefined `state.proposals`

### MINOR: Missing `lint` script in packages
**File:** All `packages/*/package.json`  
**Impact:** `bun run lint` at root fails with "No packages matched the filter"

### MINOR: Pi adapter tests are too basic
**File:** `packages/pi-adapter/tests/pi-adapter.test.ts`  
**Current:** Only 2 tests checking module loads  
**Needed:** Tests verifying tool registration with a mock ExtensionAPI

## Technical Decisions
| Decision | Justification | Agent |
|----------|---------------|-------|

## Artifacts Produced
| File | Agent | Status |
|------|-------|--------|
| `packages/core/src/persistence.ts` | @codegen | Fixed — 3 nil-guard patches (loadState, saveState, saveDecisions) |
| `package.json` (root) | @codegen | Updated — added `@biomejs/biome` devDependency |
| `packages/core/package.json` | @codegen | Updated — added `lint` script |
| `packages/cli/package.json` | @codegen | Updated — added `lint` script |
| `packages/pi-adapter/package.json` | @codegen | Updated — added `lint` script |
| `packages/opencode-adapter/package.json` | @codegen | Updated — added `lint` script |
| `packages/pi-adapter/tests/pi-adapter.test.ts` | @tests | Rewritten — 16 tests, 128 assertions covering mock ExtensionAPI tool/command/event registration, dao_setup, dao_propose, dao_dashboard, and before_agent_start system prompt injection |
| `biome.json` | @codegen | Updated — added `files.includes` with dist/node_modules exclusion |
| `packages/pi-adapter/src/pi-types.d.ts` | @codegen | Reformatted + biome-ignore comments for stub types |
| `packages/opencode-adapter/src/opencode-types.d.ts` | @codegen | Reformatted + biome-ignore comments for stub types |
| `packages/core/src/**/*.ts` | @codegen | Auto-fixed formatting, imports, catch clauses (`any` → `unknown`), non-null assertions → null guards, unused imports removed |
| `packages/cli/src/cli.ts` | @codegen | Auto-fixed formatting, imports, catch clause, non-null assertion |
| `packages/cli/tests/cli-e2e.test.ts` | @codegen | Auto-fixed formatting, imports, biome-ignore for process.stdout/stderr mock |
| `packages/pi-adapter/src/index.ts` | @codegen | Auto-fixed formatting, catch clauses, event handler return type |
| `packages/opencode-adapter/src/index.ts` | @codegen | Auto-fixed formatting, catch clauses, biome-ignore for execute signatures |
| `packages/pi-adapter/tests/pi-adapter.test.ts` | @codegen | Auto-fixed formatting, biome-ignore for mock interfaces, unused import removed |
| `packages/core/tests/*.test.ts` | @codegen | Auto-fixed formatting, biome-ignore for test mocks |

## Inter-Agent Notes
<!-- Format: [@source → @destination] Message -->
