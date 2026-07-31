# Swarm DAO Integration Tests

Cross-package tests that exercise the seams unit tests cannot reach: the
host-tool surface, real host adapters, on-disk state, and the MCP protocol.

```
tests/e2e/            # full proposal lifecycle against a real FileDaoStateRepository
tests/cross-host/     # several hosts driving one governance state
tests/compatibility/  # every stdio adapter honours the same HostAdapter contract
tests/support/        # workspace + host fixtures
```

## Running

```bash
bun run test:integration        # from the repo root
bun test tests/e2e              # from this package
```

The adapters resolve through their published entry points (`dist/`), so run
`bun run build` first (the root `prepare` hook does this on `bun install`).

## What each suite guarantees

- **e2e** — `dao_setup → dao_propose → dao_deliberate → dao_control → dao_ship`
  transitions the proposal machine and persists to `.dao/state.json`, including
  rejection, red-zone dry-run enforcement, and dependency blocking.
- **cross-host** — a proposal deliberated on an auto host (Pi/OpenCode class)
  can be controlled and shipped by another host from persisted state, a manual
  stdio host reaches the same verdict via `dao_record_outputs`, and workspaces
  owned by different hosts stay isolated.
- **compatibility** — the MCP server exposes exactly the tools the command
  registry maps to the `mcp` host, drives the whole flow over the protocol, and
  the claude/codex/copilot/mcp adapters share one sandboxed file, exec, and
  agent-dispatch behaviour.
