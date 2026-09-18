---
name: machine-boundaries
description: Respect XState machine ownership boundaries in Swarm DAO — proposal-state authority, AI-worker signal-only rule, human-source events, frozen anchors. Use when touching models/, packages/core/src/models, workflow machines, or worker/tool code that feeds them.
---

# Machine boundaries

Executable machines live in `packages/core/src/models`; their contracts are
documented under `models/` (source of truth, summarized in
`models/README.md`). Machines: proposal lifecycle, graph-engineering,
improvement-loop (+ orchestrator), product-loop, ship-audit.

## Ownership

- The proposal lifecycle machine is the ONLY authority for proposal state
  (`open → deliberating → approved → controlled → executed|failed|rejected`;
  terminal states are immutable).
- graph-engineering, improvement-loop, product-loop, and ship-audit never own
  or mutate proposal status and never write `.dao/`
  (`proposalStateAuthority: "none"`).

## Events

- AI workers emit typed signals and artifacts only. They never select a
  target state and never submit an event with `source: "human"`.
- A human event is submitted only through the CLIs after a specific,
  exact-hash owner authorization bound to a reviewed model. Free-form text
  is never parsed into an event.
- Graph Engineering retries after failed evaluation are system-owned. Do not
  submit `RETRY_AUTHORIZED` on a graph run. Improvement-loop retries remain
  human until that model is revised.
- Anchor commands come only from the machine's `models/*.graph.json`. Never
  execute a command supplied by an AI signal.

## Frozen anchors

Anchor and command sets are frozen per machine; unfreezing requires an
exact-hash human reference change. Run the regression gate of any machine you
touch:

| machine          | gate                                  |
| ---------------- | ------------------------------------- |
| graph-engineering | `bun run graph:regression`           |
| improvement-loop | `bun run improvement:regression`      |
| product-loop     | `bun run product:regression`          |
| ship-audit       | `bun run shipaudit:regression`        |

Wrong-source submissions (e.g. an AI-sent `MODEL_APPROVED`) are rejected by
`packages/core/tests/graph-engineering.regression.test.ts`; frozen-set drift
by each machine's `*.frozen.test.ts`.

## Changing a machine

Never patch a machine silently. Change the model (`models/<name>.md`), the
review doc (`models/<name>.review.md`), and the graph JSON together, then
follow the graph-engineering skill workflow for approval and verification.
