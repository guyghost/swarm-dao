# Context: Multi-Fix Swarm DAO

## Objective
Fix all identified findings in priority order, starting with critical and medium priorities.

## Constraints
- Platform: Node.js / Bun
- Offline first: yes (local file storage)
- Must preserve FC&IS architecture (core pure logic, shell adapters/CLI)
- Must pass all existing + new tests
- Lint/typecheck/build must exit 0
- Ralph mode: up to 10 correction iterations

## Findings & Specifications

### 1. CRITICAL: `dao_propose` in OpenCode adapter is broken (P0)
**File:** `packages/opencode-adapter/src/index.ts` (~line 152-190)
**Problem:** The `dao_propose` tool has the body of `dao_deliberate` / `dao_record_outputs`. It reads `args.proposalId`, calls `getProposal`, and transitions to deliberating — it never creates a proposal.
**Fix:** Rewrite the `execute` callback of `dao_propose` to:
- Accept args: `title`, `type`, `description`, `context?`, `problemStatement?`, `acceptanceCriteria?`, `successMetrics?`, `rollbackConditions?`, `affectedPaths?`
- Verify DAO initialized via `getState()`
- Call `createProposal(title, type, description, "user", context?)`
- Set optional fields if provided
- Call `classifyRiskZone(proposal)` and assign to `proposal.riskZone`
- Call `saveState()`
- Call `recordAudit(proposal.id, "governance", "proposal_created", "user", ...)`
- Return a formatted confirmation string with proposal id, title, type, and risk zone
- Must match the Pi adapter's `dao_propose` behavior as closely as possible

### 2. MEDIUM: OpenCode adapter tests are too basic (P1)
**File:** `packages/opencode-adapter/tests/opencode-adapter.test.ts`
**Problem:** Only 2 tests (module loads).
**Fix:** Add comprehensive tests covering:
- Plugin exports a valid Plugin object with `tool` property
- `dao_setup` tool exists and returns a string mentioning initialized agents
- `dao_propose` tool creates a proposal (mock PluginInput context)
- `dao_list` tool lists proposals
- `dao_agents` tool lists agents
- Tools gracefully handle uninitialized DAO
- Use a mock `PluginInput` context with a temporary directory

### 3. MEDIUM: `healthSnapshots` never persisted (P1)
**Files:** `packages/core/src/types/index.ts`, `packages/core/src/health-score.ts`, `packages/core/src/persistence.ts`
**Problem:** `DAOState` declares `healthSnapshots?: HealthSnapshot[]` but:
- No function ever pushes a snapshot
- `saveState`/`loadState` handle it implicitly because it's on state, but snapshots are never generated
- Dashboard shows current health but no historical trend
**Fix:**
- Add `recordHealthSnapshot(): Promise<HealthSnapshot>` in `health-score.ts` that:
  - Reads current state via `getState()`
  - Computes `computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights)`
  - Builds a `HealthSnapshot` with weekKey, year, week, score, metrics, proposalCount, createdAt
  - Appends to `state.healthSnapshots` (initializing array if undefined)
  - Calls `saveState()`
  - Returns the snapshot
- Add `getHealthSnapshots(): HealthSnapshot[]` to return state.healthSnapshots or []
- Add `getLatestHealthSnapshot(): HealthSnapshot | undefined`
- Update `generateDashboard` to optionally show trend if 2+ snapshots exist (call `getHealthTrend`)
- Add `dao_record_health` tool in Pi adapter and OpenCode adapter (optional but nice)
- For this change, focus on core functions + tests

### 4. LOW: CLI missing GitHub commands (P2)
**File:** `packages/cli/src/cli.ts`
**Problem:** README and Pi tools mention GitHub integration (create branch, open PR) but CLI has no equivalent commands.
**Fix:** Add CLI subcommands:
- `github-config --token <t> --owner <o> --repo <r>` → store in `.dao/config.json` under `github` key
- `github-branch <proposal-id>` → call `createBranch` from core integration
- `github-pr <proposal-id> --head-branch <b>` → call `openPR` from core integration
- Use existing `packages/core/src/integrations/github.ts` functions
- If config missing, print helpful error

### 5. LOW: spawnAgent stubs (P3) — OUT OF SCOPE for this cycle
Will be addressed in a future change.

## Technical Decisions
| Decision | Justification | Agent |
|----------|---------------|-------|
| `generateDashboard` accepts optional `snapshots` param instead of calling `getHealthSnapshots()` directly | Keeps `generateDashboard` pure (FC&IS); callers pass snapshots from state | @codegen |
| CLI GitHub commands read config from `.dao/config.json` via `loadGitHubConfigFromStorage()` | Avoids module-level state bleed between tests; each command is self-contained | @codegen |
| Removed unused `buildDispatchInstructions` import from opencode-adapter | Was only used in the broken `dao_propose` body; cleanup after fix | @codegen |
| Test file imports updated from dynamic fallback to direct import | Functions now exported from core; fallback pattern caused redeclaration lint errors | @codegen |

## Artifacts Produced
| File | Agent | Status |
|------|-------|--------|
| `packages/opencode-adapter/src/index.ts` | @codegen | Modified — Fixed `dao_propose`, removed unused import |
| `packages/core/src/health-score.ts` | @codegen | Modified — Added `recordHealthSnapshot`, `getHealthSnapshots`, `getLatestHealthSnapshot`, updated `generateDashboard` |
| `packages/core/src/index.ts` | @codegen | Unchanged (auto-exports via `export *`) |
| `packages/cli/src/cli.ts` | @codegen | Modified — Added `github-config`, `github-branch`, `github-pr` commands |
| `packages/pi-adapter/src/index.ts` | @codegen | Modified — Updated `generateDashboard` call to pass snapshots |
| `packages/core/tests/health-score.test.ts` | @codegen | Modified — Updated imports, fixed lint, updated `generateDashboard` call |
| `packages/opencode-adapter/tests/opencode-adapter.test.ts` | @codegen | Modified — Removed unused imports, fixed lint |
| `packages/cli/tests/cli-e2e.test.ts` | @codegen | Modified — Fixed formatting |

## Inter-Agent Notes
<!-- Format: [@source → @destination] Message -->
[@codegen → @tests] All 3 changes implemented. 138/138 tests pass. typecheck/lint/test all exit 0. Note: `generateDashboard` now takes an optional 4th `snapshots?: HealthSnapshot[]` parameter to maintain purity.
