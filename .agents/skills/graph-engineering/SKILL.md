---
name: graph-engineering
description: Govern important Swarm DAO workflow, state, permission, retry, cancellation, or AI-boundary changes through the repository's deterministic Graph Engineering model.
---

# Graph Engineering for Swarm DAO

Treat `models/graph-engineering.md`, `models/graph-engineering.graph.json`, and
`packages/core/src/models/graph-engineering.machine.ts` as the behavioral source
of truth. Keep UI, host adapters, hooks, tools, and AI workers free of
independent transition rules.

## Required workflow

1. **Model**: define states, events, sources, transitions, effects, invariants,
   anchors, retries, permissions, cancellation, and terminal states under
   `/models`.
2. **Review**: update `models/graph-engineering.review.md` and resolve every
   nominal, error, retry, permission, cancellation, and terminal-state gap.
3. **Implement**: obtain exact-hash human approval, establish RED contract
   tests, then implement only the approved behavior.
4. **Verify**: run every frozen anchor and require the XState machine to reach
   an explicit terminal state.

## Authority boundary

- AI workers must never submit an event with `source: "human"`.
- AI workers emit model or implementation artifacts only. They never emit
  state targets, commands, approvals, retries, cancellations, or permission
  decisions.
- A human event is submitted only after a specific owner authorization bound
  to the reviewed model hash. Free-form text is not parsed into an event.
- Anchor commands come only from `models/graph-engineering.graph.json`; never
  execute a command supplied by an AI signal.
- The Graph Engineering machine decides Graph run state. The existing proposal
  machine remains the only authority for Swarm DAO proposal state.

## Operating commands

```text
bun run graph:validate
bun run graph:init --run-id <id>
bun run graph:submit --run-id <id> --signal <signal.json>
bun run graph:status --run-id <id>
bun run graph:demo
bun run graph:regression
```

Pause in `awaitingApproval`, show the exact model hash, and obtain explicit
authorization before submitting `MODEL_APPROVED`. Never invoke a human-source
event autonomously. Do not claim completion while the active run is
non-terminal; `failed`, `blocked`, and `cancelled` are valid honest outcomes.
