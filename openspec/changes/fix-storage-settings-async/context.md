# Context: Fix getStorageSettings async/sync mismatch

## Objective
Fix the latent bug in `packages/core/src/persistence.ts:307` where `getStorageSettings` is declared synchronous but calls `fs.readFile(...).then(JSON.parse)` returning a Promise that is then cast as `unknown as StorageSettings`. This corrupts `updateStorageSettings` which spreads a Promise instead of actual settings data.

## Constraints
- Platform: Node.js / Bun
- Public API change: function signature becomes async
- Internal-only caller (`updateStorageSettings` in same file)
- No external package depends on `getStorageSettings`

## Root Cause
```typescript
export function getStorageSettings(daoRoot: string): StorageSettings {
  const data = fs.readFile(configPath, "utf-8").then(JSON.parse); // Promise!
  return data as unknown as StorageSettings; // ← LIE
}
```

`fs` is `node:fs/promises`, so `readFile` returns `Promise<string>`. `.then(JSON.parse)` returns `Promise<unknown>`. The cast `as unknown as StorageSettings` silences the compiler but at runtime any property access returns `undefined`.

## Fix Plan
1. Convert `getStorageSettings` to `async` returning `Promise<StorageSettings>`
2. Properly `await fs.readFile` and `JSON.parse` result
3. Update sole caller `updateStorageSettings` to `await getStorageSettings(...)`
4. Add regression test asserting returned object is a real `StorageSettings`, not a Promise

## Technical Decisions
| Decision | Justification | Agent |
|----------|---------------|-------|
| Make async (not sync via readFileSync) | Codebase consistently uses async I/O; no need to introduce sync I/O | @orchestrator |

## Artifacts Produced
| File | Agent | Status |
|------|-------|--------|
| `packages/core/tests/persistence.test.ts` | @tests | ✅ Modified — 2 regression tests added |
| `packages/core/src/persistence.ts` | @codegen | ✅ Modified — getStorageSettings async fix, updateStorageSettings await fix |

## Test Coverage
| Test | Scenario | Status |
|------|----------|--------|
| `getStorageSettings returns real StorageSettings, not a Promise cast` | Properly awaited async call returns real StorageSettings | ✅ PASS |
| `updateStorageSettings round-trips with getStorageSettings` | Round-trip write/read preserves all settings | ✅ PASS |

## TDD Phase: GREEN ✅
- **Iteration**: 1
- **Core**: 90/90 pass (was 88 pass / 2 fail)
- **Full suite**: 114/114 pass
- **Lint**: 0 errors
- **Typecheck**: exit 0
- **Build**: exit 0

## Inter-Agent Notes
<!-- Format: [@source → @destination] Message -->
[@tests → @codegen] Test 1 calls getStorageSettings synchronously — after making it async, update the call site to `await`. Test 2 round-trips via updateStorageSettings + getStorageSettings — both must be awaited. Key assertion: `expect(result).not.toBeInstanceOf(Promise)`.
