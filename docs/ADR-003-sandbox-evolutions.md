# ADR-003: Evolutions Execute in Bounded Containers

## Status

Proposed (2026-08-31)

## Context

The improvement loop and the delivery layer now run end-to-end from the CLI:

- `swarm-dao improve` drives series in any project; AI workers already execute
  as real coding agents inside herdr workspaces (host-side isolation);
- anchor commands — the ground-truth gates — can already execute inside a
  bounded Docker / Apple `container` sandbox (network disabled, repository
  bind-mounted at `/workspace`, CPU/memory capped) via
  `@guyghost/swarm-dao-improvement`'s sandbox runner (PR #82).

What remains host-bound is the **execution of evolutions themselves**: when a
proposal is executed (or an improvement agent makes a change), the coding
agent and its shell effects run on the host, inside a git worktree
(`planExecutionIsolation`: `none | worktree`). A worktree isolates the
*files* an agent touches; it does not bound what the agent's commands can
reach — the network, the host filesystem outside the worktree, or process
resources. For swarm-dao the operator is the developer; for the CLI's target
audience — running improvement loops against arbitrary projects — the agent
must be at least as bounded as the gates.

Apple's `container` runtime (macOS 26+) and Docker both provide fast,
per-invocation Linux containers with bind mounts, resource limits, and no
default networking. Both are already exercised by the sandbox runner.

## Decision

Evolution execution gains a sandbox backend with the same shape and failure
philosophy as the anchor sandbox:

1. **One port, two runtimes.** `ContainerRunnerPort` (in the improvement
   package today, promoted to a shared delivery port) gains an evolution
   entry point: create a workspace container from a git worktree — mount the
   worktree at `/workspace`, network off, CPU/memory capped, image owned by
   the project configuration (`.dao/improvement.json` → `sandbox`), strict
   OCI reference validation. Docker and Apple `container` remain adapters
   behind identical semantics; `auto` prefers Apple `container` and fails
   loudly when no runtime exists.

2. **Agents inside the boundary, signals outside.** The coding agent
   (e.g. `pi`) runs as the container's process, pointed at the mounted
   worktree; its outputs return through the same channel as herdr harvests —
   structured signals, never state. herdr remains the host-side terminal
   manager for deliberation; sandboxed evolution replaces herdr only where
   the agent must *modify* the target, because herdr owns a host terminal
   and cannot run inside the container.

3. **The proposal machine stays the only authority.** A sandboxed execution
   is an effect authorized by `controlled` state, exactly like today's
   worktree preparation. The sandbox derives its plan from the proposal
   (image, limits, network) and reports honest outcomes; it can never
   transition state, approve, or unblock. Permission denials surface as
   `blocked`, as today.

4. **Bounded means bounded.** No implicit host fallback: if a sandbox mode
   is requested and the runtime is missing, execution fails with guidance.
   The host-execution path remains available only through explicit
   `sandbox: none` (default for existing users), recorded in the execution
   journal so every historical run's boundary is auditable.

## Alternatives considered

- **Host agents + worktree only** (status quo): simplest, but the boundary
  protects files, not effects. Rejected for third-party projects.
- **Remote dev-containers / VM farms**: stronger isolation, but adds
  infrastructure the CLI's single-operator model cannot assume; local
  runtimes already provide the needed bounds.
- **Proxying only the agent's tool calls** (denylist firewall in the agent
  harness): finer-grained, but couples the DAO to one agent's extension API
  and re-implements what the OS already enforces.

## Consequences

### Positive

- evolutions on untrusted or sensitive target projects run with enforced
  filesystem, network, and resource bounds;
- one sandbox contract covers gates today and evolutions tomorrow; the CLI
  surface (`--sandbox`, `.dao` config) does not grow a second vocabulary;
- container images pin each project's toolchain — an evolution is replayed
  against the exact toolchain it was proposed for.

### Negative

- container startup cost per execution (seconds; amortized by keeping one
  container per proposal execution rather than per command);
- images become part of the trust base and must be pinned by digest for
  untrusted targets;
- Apple `container` and Docker differ in edge semantics (mount propagation,
  user mapping); adapters must document their deltas honestly.

## Rollout

1. Promote the sandbox runner to a shared port; adapters keep unit-tested
   command construction and injectable execution (already the pattern).
2. Wire the delivery layer's execution preparation to accept
   `sandbox: docker | container | auto | none` next to `worktree`.
3. Opt-in integration test (env-gated, like `HERDR_IT=1`) running a trivial
   evolution in `alpine` and asserting the journal shows an honest outcome.
