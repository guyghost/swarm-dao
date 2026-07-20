# Swarm DAO Behavioral Models

This directory is the architectural source of truth for workflows and state decisions.
Executable XState models live under `packages/core/src/models`; documentation here explains
their boundaries and review status.

## Dependency direction

```text
hosts -> adapters -> application -> models/domain
                    |             ^
                    +-- ports ----+

presenters <- hosts/application results
```

Invariants:

1. Models own every business-state transition.
2. Models and domain rules perform no I/O and use no ambient clock, randomness, or host SDK.
3. Application use cases orchestrate models and ports; they never import infrastructure adapters.
4. AI workers produce typed signals. They never select a target state.
5. Repositories are instance-owned. A host may not use process-global state as its runtime boundary.
6. Presenters transform structured results and contain no business decisions.

## Effect model

Application workflows follow this shape:

```text
command + current state + injected inputs
  -> model/domain decision
  -> next state + structured result
  -> application persists through the repository port
  -> host shell performs remaining technical effects
```

## Proposal lifecycle

States: `open`, `deliberating`, `approved`, `controlled`, `executed`, `failed`, `rejected`.

| From | Event | Guard | To |
|---|---|---|---|
| open | DELIBERATE | — | deliberating |
| deliberating | APPROVE | approved tally | approved |
| deliberating | REJECT | — | rejected |
| approved | CONTROL_PASS | all gates passed, no blocker | controlled |
| approved | CONTROL_FAIL / FAIL | — | failed |
| controlled | EXECUTE_SUCCESS | — | executed |
| controlled | FAIL | — | failed |
| any non-terminal | DISCARD | — | rejected |
| any non-terminal | ERROR | — | failed |

Terminal states are immutable. Rollback is a compensating technical action based on an execution
snapshot; it does not rewrite the historical proposal lifecycle.

AI worker outputs are signals only: agent text is parsed into votes and scores, then deterministic
tally, gate, and lifecycle policies select the permitted event and transition.

## Graph Engineering change control

`graph-engineering.md` and `graph-engineering.graph.json` define a separate
repository-local workflow for Codex change runs. Its executable XState model
lives in `packages/core/src/models/graph-engineering.machine.ts`.

This workflow never owns or mutates proposal status and never writes `.dao/`.
It gates implementation through exact-hash human approval and six deterministic
anchors while the proposal lifecycle above remains the sole business-state
authority.

## Review checklist

Before adding or changing a workflow, cover:

- nominal transitions;
- invalid transitions and permissions;
- cancellation and terminal-state immutability;
- errors and explicitly modelled retry behavior;
- deterministic time and identifiers;
- absence of direct LLM-driven transitions;
- repository isolation and presenter independence.
