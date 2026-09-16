---
name: host-adapter
description: Add or modify a Swarm DAO host adapter package (Pi, OpenCode, Claude, Codex, Copilot, herdr, tmux, or a new host). Use when creating a host integration or touching packages/*-adapter.
---

# Host adapters

A host adapter is a thin shell. It owns process spawning and host SDK calls;
it never owns governance decisions. `docs/EXTENSION-GUIDE.md` is the full
walkthrough; this skill is the enforceable short version.

## Pick the right shape

1. **Stdio delegation** (Claude, Codex, Copilot): the host runs the Swarm DAO
   MCP server as a subprocess. Wrap `createStdioHostAdapter` from
   `@guyghost/swarm-dao-mcp` — see `packages/claude-adapter/src/index.ts`
   (~15 lines). Prefer this for any host that can run an MCP/CLI tool.
2. **Full lifecycle adapter** (Pi, OpenCode): the adapter wires the DAO
   command surface itself. Every file under `packages/*-adapter/src` that
   imports `FileDaoStateRepository` is auto-discovered and gated by
   `packages/core/tests/architecture.contract.test.ts`, which requires:
   - instance-owned state via `FileDaoStateRepository.open` (scoped to the
     DAO root; never a process-global repository);
   - every lifecycle command routed through the shared application handlers
     (`handleDaoSetup`, `handleDaoPropose`, `handleDaoDeliberate`,
     `handleDaoControl`, `handleDaoExecute`, `handleDaoDryRun`,
     `handleDaoRollback`, `handleDaoRoundtable`);
   - no direct `dispatchProposalEvent`, `runGates`, `executeProposal`,
     `performDryRun`, `performRollback`, `runRoundTable`, or
     `createProposalsBatch` calls;
   - no `new LegacyDaoStateRepository`.

## Package checklist

- `package.json`: publishable name `@guyghost/swarm-dao-<host>-adapter`,
  `exports` map, build/test/lint/typecheck scripts, dependency on core with
  a `^` range — never `workspace:` (`bun run check:publish-manifests` fails
  CI on a leaked workspace protocol).
- Tests under `tests/` mirroring an existing adapter
  (`packages/copilot-adapter/tests/copilot-adapter.test.ts` is the minimal
  example, `packages/tmux-adapter/tests/adapter.test.ts` a fuller one).
- A changeset covering the new or changed package whenever `src/` changes
  (`bun run check:changesets` fails PRs without one).
- Write model/review docs only if the host adds workflow behavior; spawning
  subprocesses is not a state decision.

Verify:

```text
bun run build && bun run lint && bun run typecheck
bun test packages/<adapter-name>
bun run check:publish-manifests
```
