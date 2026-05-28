# Context: Pi Parity & Health Snapshot Dedup

## Objective
Address the three minor non-blocking suggestions from @review in the multi-fix change.

## Constraints
- Platform: Node.js / Bun
- Preserve FC&IS architecture
- Must pass all tests (existing + new)
- Lint/typecheck/build must exit 0
- Ralph mode: up to 10 correction iterations

## Suggestions to Implement

### 1. Pi adapter parity with OpenCode (Suggestion #1 & #2 from @review)
**File:** `packages/pi-adapter/src/index.ts`
**Current issues:**
- `DaoProposeParams` interface lacks `affectedPaths` field (OpenCode has it)
- `dao_propose` tool assigns optional fields with truthy checks (e.g. `if (params.acceptanceCriteria)`) instead of `!== undefined` checks. This means an explicit empty array `[]` would be skipped, and `undefined` would be assigned unconditionally for `problemStatement` (line 303: `proposal.problemStatement = params.problemStatement`)

**Fix:**
- Add `affectedPaths?: string[]` to `DaoProposeParams` interface
- In `dao_propose` execute callback, guard all optional field assignments with `!== undefined`:
  ```typescript
  if (params.problemStatement !== undefined) proposal.problemStatement = params.problemStatement;
  if (params.acceptanceCriteria !== undefined) proposal.acceptanceCriteria = params.acceptanceCriteria;
  if (params.successMetrics !== undefined) proposal.successMetrics = params.successMetrics;
  if (params.rollbackConditions !== undefined) proposal.rollbackConditions = params.rollbackConditions;
  if (params.affectedPaths !== undefined) proposal.affectedPaths = params.affectedPaths;
  ```
- Update the tool's `parameters` schema to include `affectedPaths: Type.Optional(Type.Array(Type.String()))`

### 2. Health snapshot same-week dedup (Suggestion #3 from @review)
**File:** `packages/core/src/health-score.ts`
**Current behavior:** `recordHealthSnapshot` blindly appends a new snapshot every time it's called. If called multiple times in the same week, multiple entries with the same `weekKey` accumulate.
**Fix:** Change `recordHealthSnapshot` to upsert: if a snapshot with the same `weekKey` already exists, replace it instead of appending. Then prune to last 52.

### 3. Trailing newline in saveState (biome formatting)
**File:** `packages/core/src/persistence.ts`
**Current behavior:** `saveState` writes `JSON.stringify(state, null, 2)` without a trailing newline. Biome formatter expects files to end with newline.
**Fix:** Change `fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8")` to `fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8")`

## Technical Decisions
| Decision | Justification | Agent |
|----------|---------------|-------|

## Artifacts Produced
| File | Agent | Status |
|------|-------|--------|

## Inter-Agent Notes
<!-- Format: [@source → @destination] Message -->
