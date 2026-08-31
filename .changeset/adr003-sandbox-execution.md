---
"@guyghost/swarm-dao-core": minor
"@guyghost/swarm-dao-improvement": patch
---

ADR-003 accepted: sandboxed proposal execution. `planExecutionIsolation` and `createExecutionWorkspace` accept `execution.isolation: "sandbox"` (worktree + bounded container: runtime probed before provisioning, network disabled, CPU/memory capped, image strictly validated) next to `worktree`; the pure container command builder moves to core delivery (`buildSandboxCommand`, `validateSandboxImage`) and the improvement package reuses it. Env-gated integration test (`EVOLUTION_IT=1`) proves a trivial evolution lands in the sandboxed worktree.
