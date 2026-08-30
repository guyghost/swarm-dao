# Swarm DAO Ship Audit Challenge

## Objective

Adapt swarm-forge's `AUDIT_REQUIRED` handoff gate to proposal shipping: when the
challenge is enabled, the first `dao_ship` call for a proposal does **not**
execute — it returns `AUDIT_REQUIRED` and records the exact decision
fingerprint being shipped. Only a second call whose fingerprint is **unchanged**
executes. Any change to the decision between the two calls (new vote, failed
gate, edited description, new dependency) voids the confirmation and issues a
fresh challenge. The pattern forces a genuine re-reading of what is about to
ship instead of a rubber-stamp.

The ship audit never owns proposal state. It decides exactly one thing:
whether a ship call may proceed to the existing `ShipProposalUseCase` — which
remains the only path to `executed`.

## Architectural boundary

1. `packages/core/src/models/ship-audit.machine.ts` is the only authority for a
   proposal's audit-challenge state. It is pure: no I/O, no ambient clock, no
   randomness, no `async`, no `node:` imports (enforced by
   `architecture.contract.test.ts`).
2. The machine never mutates proposal state, never emits proposal events, and
   never writes `.dao/state.json`. Correlation is the immutable `proposalId`;
   it grants no permission in the proposal machine and causes no transition
   there (`proposalStateAuthority: "none"`).
3. The deterministic ship handler (host-tools) consults the machine before
   invoking `ShipProposalUseCase`. AI workers never participate: there is no
   AI role in this model — the challenge is a system-to-system confirmation
   protocol with human escape hatches.
4. Snapshots persist under `.dao/ship-audits/<proposalId>.json` through an
   injected store port. The machine performs no filesystem access.
5. Fingerprints are computed by a pure function over the proposal's
   decision-relevant content (id, title, type, description, status, dependsOn,
   votes with positions and weights, control summary). Timestamps are injected,
   never read.

## Configuration

Opt-in, per project (`.dao/config.json`):

```json
{ "ship": { "auditChallenge": true } }
```

Default: disabled — `dao_ship` behaves exactly as before (single call
executes). The existing `--force` flag becomes an explicit, audited human
bypass of the challenge.

## Roles and graph

| Node | Kind | Authority | Responsibility |
| --- | --- | --- | --- |
| `ship-handler` | deterministic system | gate | Emit `SHIP_REQUESTED` on every ship call; consult the machine; either return `AUDIT_REQUIRED` or proceed to `ShipProposalUseCase` |
| `fingerprint-sealer` | deterministic tool | anchor | Compute the canonical decision fingerprint of the proposal being shipped |
| `human-owner` | human | escape hatch | `FORCE_OVERRIDE` (the audited `--force` path) or `CANCEL` |

There is deliberately **no AI worker**: the audit challenge is a
deterministic confirmation protocol. An LLM must never confirm, challenge, or
bypass a ship.

## Workflow model

### States

```text
fresh ──SHIP_REQUESTED──► challenged ──SHIP_REQUESTED (unchanged fingerprint)──► confirmed
                             │  ▲
                             │  └── SHIP_REQUESTED (changed fingerprint: re-challenge)
                             ├── FORCE_OVERRIDE ──► bypassed*
                             └── CANCEL ──► cancelled*
confirmed ──SHIP_CONSUMED──► fresh        (cycle reset after exactly one execution attempt)
fresh/challenged ── FORCE_OVERRIDE ──► bypassed*
any active ── CANCEL ──► cancelled*
```

`bypassed` and `cancelled` are terminal and immutable.

### Events and permitted sources

| Event | Source | From | To / effect |
| --- | --- | --- | --- |
| `SHIP_REQUESTED` | `system` | fresh | challenged; record fingerprint; `challengeCount = 1` |
| `SHIP_REQUESTED` | `system` | challenged | fingerprint unchanged → confirmed; changed → challenged with the new fingerprint, `challengeCount += 1`, prior audit void |
| `SHIP_REQUESTED` | `system` | confirmed | self-transition consumed below by `SHIP_CONSUMED` (the handler proceeds immediately) |
| `SHIP_CONSUMED` | `system` | confirmed | fresh; the single confirmation was spent on one execution attempt |
| `FORCE_OVERRIDE` | `human` | fresh, challenged | bypassed; record reason |
| `CANCEL` | `human` | any active | cancelled; record reason |

Events from the wrong source or state are rejected and journaled. Free-form
text is never parsed into an event.

## Invariants

- **INV-1 (no unconfirmed ship):** with the challenge enabled, a ship call
  executes only from `confirmed` or through the human `FORCE_OVERRIDE`.
- **INV-2 (fingerprint binding):** a confirmation is valid only for the exact
  fingerprint challenged; any change re-issues the challenge.
- **INV-3 (no AI authority):** no event source is `ai`; confirmation is a
  deterministic property of two identical requests, not a judgment.
- **INV-4 (correlation without permission):** `proposalId` correlates the audit
  context; it grants no proposal-state permission and never transitions the
  proposal machine.
- **INV-5 (terminal immutability):** `bypassed` and `cancelled` accept no
  events.
- **INV-6 (single spend):** a confirmation authorizes exactly one execution
  attempt (`SHIP_CONSUMED` resets the cycle).

## Anchors

| command | anchor |
| --- | --- |
| `bun run shipaudit:validate` | audit-model-contract |
| `bun test packages/core/tests/ship-audit.machine.test.ts tools/ship-audit/tests` | audit-graph-tests |
| `bun test packages/core/tests/ship-audit.wiring.test.ts` | audit-wiring-contract |
| `bun run shipaudit:regression` | audit-regression |
| `bun run shipaudit:demo` | audit-runtime-scenario |

## Evidence

Runtime snapshots live in `.dao/ship-audits/` (injected store, machine stays
pure). Change-control evidence for the implementation run lives under
`evidence/graph-runs/` and is not committed.
