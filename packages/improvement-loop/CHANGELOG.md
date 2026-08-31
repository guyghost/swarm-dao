# @guyghost/swarm-dao-improvement

## 0.2.1

### Patch Changes

- 82df3ed: ADR-003 accepted: sandboxed proposal execution. `planExecutionIsolation` and `createExecutionWorkspace` accept `execution.isolation: "sandbox"` (worktree + bounded container: runtime probed before provisioning, network disabled, CPU/memory capped, image strictly validated) next to `worktree`; the pure container command builder moves to core delivery (`buildSandboxCommand`, `validateSandboxImage`) and the improvement package reuses it. Env-gated integration test (`EVOLUTION_IT=1`) proves a trivial evolution lands in the sandboxed worktree.
- Updated dependencies [82df3ed]
  - @guyghost/swarm-dao-core@0.10.0
  - @guyghost/swarm-dao-herdr-adapter@0.2.4

## 0.2.0

### Minor Changes

- 08a8b29: Improvement loop everywhere: new `@guyghost/swarm-dao-improvement` executor package (series orchestrator, cycle runner, herdr workers, per-project `.dao/improvement.json` anchor config) and `swarm-dao improve init|status|once|submit` CLI commands to run improvement series in any project. Anchor commands can execute in a bounded sandbox (`--sandbox docker|container|auto|none --image <ref>`: network off, repo mounted at /workspace, CPU/memory caps) via Docker or Apple container. Core gains the `models/improvement` export subpath and the `improve` registry entry.

### Patch Changes

- Updated dependencies [774bc5d]
- Updated dependencies [08a8b29]
  - @guyghost/swarm-dao-core@0.9.0
  - @guyghost/swarm-dao-herdr-adapter@0.2.3
