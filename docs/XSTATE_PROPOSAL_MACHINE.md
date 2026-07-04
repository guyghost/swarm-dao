# Proposal Lifecycle State Machine

The proposal lifecycle is modelled as an **XState v5 machine** that is the
sole source of truth for every status transition. There is exactly one
sanctioned way to move a proposal between statuses — the dispatch service
`dispatchProposalEvent`. No code mutates `proposal.status` directly.

## Why a model, not a matrix

This project follows a strict discipline:

> **Model → Review → Implement → Verify.** If the behaviour cannot be
> modelled, it is not ready to be implemented. If a state transition
> depends on an LLM, the architecture is wrong. **The LLM produces
> signals; the model decides.**

The previous design kept two parallel systems — a 15-state XState machine
that nothing drove, and a hand-rolled `VALID_TRANSITIONS` matrix that ran
production. This file documents the distilled replacement: the 7 statuses
that actually exist, the events that move between them, and the guards
that make permissions into invariants of the model.

## The model

Seven states, mirroring `ProposalStatus` one-for-one:

```text
open         ──DELIBERATE──▶  deliberating
open         ──DISCARD────▶   rejected

deliberating ──APPROVE[tallyApproved]──▶  approved
deliberating ──REJECT─────────────────▶   rejected

approved     ──CONTROL_PASS[gatesPassed]──▶  controlled
approved     ──CONTROL_FAIL────────────────▶  failed
approved     ──REJECT | DISCARD────────────▶  rejected
approved     ──FAIL────────────────────────▶  failed

controlled   ──EXECUTE_SUCCESS──▶  executed
controlled   ──FAIL─────────────▶  failed
controlled   ──DISCARD──────────▶  rejected

executed   ─ final
failed     ─ final
rejected   ─ final
```

Two **escape hatches** are available from every non-terminal state:

- `DISCARD` → `rejected` (explicit cancellation by an operator)
- `ERROR { message }` → `failed` (any unrecoverable runtime error)

Final states (`executed`, `failed`, `rejected`) are `type: "final"` and
ignore further events.

### Distill decisions

- **No `executing` transitory state.** The current runtime executes
  proposals synchronously; nothing observes an intermediate state.
  Success or failure is an explicit `EXECUTE_SUCCESS` / `FAIL` event.
- **No retry.** The old machine carried a 3× retry loop that production
  never wired up. If async execution arrives later, the model will grow
  from the shape the runtime actually takes.
- **Only two guards.** Risk-zone / mandatory-dry-run is already enforced
  upstream by the `mandatory-dry-run` control gate in
  `control/gates.ts`, which makes `ControlCheckResult.allGatesPassed`
  false for red-zone proposals without a dry run. Duplicating that here
  would be unearned complexity.

## Guards (permissions as invariants)

| Guard | Fires on | Condition |
| --- | --- | --- |
| `tallyApproved` | `APPROVE` | `event.tally.approved === true` |
| `gatesPassed` | `CONTROL_PASS` | `event.result.allGatesPassed && event.result.blockerCount === 0` |

A guard that fails leaves the proposal in its current state; the
dispatch service reports the transition as rejected (see below).

## The dispatch service

`dispatchProposalEvent(proposal, event): DispatchResult` is the only
sanctioned mutation path. It:

1. Refuses to act if the proposal is already in a final status
   (`isProposalFinal`) — terminal immutability is explicit, not an
   XState implementation detail.
2. Rehydrates an actor at the proposal's persisted status via
   `createProposalMachine(initial)`.
3. Asks the actor `.can(event)` (guards evaluated).
4. If allowed, sends the event and writes the new status and
   `resolvedAt` back onto the proposal. On a terminal transition it
   stamps `resolvedAt`.
5. Returns `{ ok: true, status }` or `{ ok: false, error }`.

```ts
import { dispatchProposalEvent } from "@guyghost/swarm-dao-core/governance";
import type { Proposal } from "@guyghost/swarm-dao-core/types";

const result = dispatchProposalEvent(proposal, { type: "DELIBERATE" });
if (!result.ok) {
  console.warn(result.error); // e.g. guard failed or terminal
}
```

Payload-bearing events carry the full tallied / control-checked result;
the guard reads it, the caller never picks the target status:

```ts
dispatchProposalEvent(proposal, {
  type: "APPROVE",
  tally, // TallyResult — produced by the voting AI workers (signal)
});

dispatchProposalEvent(proposal, {
  type: "CONTROL_PASS",
  result, // ControlCheckResult — produced by the control gates (signal)
});
```

> The LLM workers produce votes and gate verdicts. They never choose a
> status. The machine decides from the signal.

## What was removed

- `VALID_TRANSITIONS` / `canTransition` / `transitionProposal` from
  `lifecycle.ts` — the hand-rolled matrix. Risk helpers
  (`classifyRiskZone`, `getRequiredApprovals`, `requiresSecurityReview`)
  remain; they are read-only inputs, not transitions.
- `updateProposalStatus` from `persistence.ts` — a backdoor that did
  `proposal.status = status` with no validation. Gone.
- The actor-facing helpers `createProposalActor`, `sendProposalEvent`,
  `progressProposal`, `getProposalContext`, `getProposalState`,
  `canSendProposalEvent`, `getAvailableProposalEvents`,
  `onProposalStateChange` — the dead 15-state API with no production
  consumer.

## Where the model is consumed

| Consumer | Calls |
| --- | --- |
| `host-tools/handlers.ts` | `dispatchProposalEvent` (7 sites) |
| `delivery/execution.ts` | `dispatchProposalEvent` + `isProposalFinal` guard before execution |
| `pi-adapter` | `dispatchProposalEvent` (5 sites) |
| `opencode-adapter` | `dispatchProposalEvent` (4 sites) |

No consumer names a target status. Every transition is an event.

## Validation

The machine is tested for nominal flow, guards, forbidden transitions,
escape hatches, and terminal immutability in:

- `packages/core/tests/proposal.machine.test.ts`

Run focused checks:

```bash
bun run --cwd packages/core lint
bun run --cwd packages/core typecheck
bun run --cwd packages/core test -- proposal.machine.test.ts
```
