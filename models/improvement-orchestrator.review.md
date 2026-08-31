# Review: Swarm DAO Improvement Orchestrator

## Decision

The behavioral model is complete and ready for an explicit owner decision on
its exact hash. Implementation remains forbidden until that approval event is
provided.

## Coverage

| Concern | Model coverage | Decision |
| --- | --- | --- |
| Nominal path | Init cycle → workers → seal → drift → arbitration → anchors → evaluate → observe → cooldown → next cycle | Covered |
| Continuity | `cooldown` + `COOLDOWN_ELAPSED` loops on success only; sequence increments per cycle | Covered |
| Human cycle gates | `awaitingHumanCycleDecision` on `adjusting`/`retrying`; `CYCLE_RESUMED` only after the owner acted through `improvementctl` | Covered |
| Cycle failure | `halted` on failed/blocked/cancelled cycle; restart is human-gated | Covered |
| Worker failure | Blocked, timed-out, or unparseable workers end in `workerFailed`; bounded effect-level retries (two, fresh workspace each) | Covered |
| Signal rejection | Runner-rejected submissions end in `workerFailed` with recorded issues | Covered |
| Anchor honesty | Commands frozen in the improvement graph JSON; failed anchors submitted as failed, never retried by the orchestrator | Covered |
| Cancellation | Human `CANCEL_SERIES` accepted from every active state | Covered |
| Restart | `RESTART_SERIES` is a human event from `halted` only | Covered |
| Terminal behavior | `idle` and `cancelled` reject all later events | Covered |
| Single active series | One active series per scope; concurrent starts rejected | Covered |
| Determinism | Journal replay restores the series snapshot; clock injected for cooldown | Covered |
| LLM boundary | Workers produce typed signals via the existing validator; no state, reference, anchor, or arbitration authority anywhere in the series | Covered |
| Cross-machine boundary | Cycle/proposal/graph authority unchanged; correlation immutable and one-way | Covered |
| Hexagonal boundary | Machine pure; herdr, submission, anchors, observation, scheduling all in the executor shell | Covered |

## Transition review

1. No transition is driven by free-form text or by AI output.
2. Every submit-phase state (`sealing`, `auditing`, `arbitrating`, `grounding`,
   `evaluating`) sequences effects only; none of them selects cycle state.
3. Human events are structured (`START_SERIES`, `RETRY_WORKERS`,
   `RESTART_SERIES`, `CANCEL_SERIES`); the orchestrator never forges or
   relays a human-source event toward the improvement machine.
4. System events are typed snapshot observations with an explicit mapping
   table; any non-mapped cycle state produces no observation.
5. Tool events report executor outcomes, including failures; a failed anchor
   outcome is submitted honestly and the improvement machine decides.
6. Wrong-source, wrong-state, and post-terminal events are rejected and
   journaled.
7. `CYCLE_RESUMED` exists only from `awaitingHumanCycleDecision` and always
   restarts the full worker sequence, because an authorized retry clears
   attempt-scoped evidence.

## Invariant review

- There is no path from `observing` to `cooldown` except through a cycle
  snapshot that says `succeeded`.
- There is no path that skips the human owner when the cycle is in
  `adjusting`, `retrying`, `failed`, `blocked`, or `cancelled`.
- The orchestrator has no event that writes cycle state, reference values,
  anchor results, or arbitration outcomes.
- Worker retries are effect-level and bounded; they cannot resurrect a failed
  cycle attempt or mutate series state.
- Terminal states are immutable; a halted series can only restart through a
  human event, and the restart initializes a new cycle sequence number.
- Series state cannot mutate proposal, Graph Engineering, Product Loop, or
  Improvement cycle state.
- Core-model purity is protected by the existing architecture contract tests.

## Implementation review

The planned implementation reuses the repository's XState dependency, the
existing `improvementctl` runner and signal validator, and the herdr adapter's
battle-tested workspace lifecycle (create → start → prompt --wait → read →
close). It adds a series tool adapter under `tools/improvement-loop/` and a
pure machine under `packages/core/src/models/`, mirroring the improvement loop
layout. The frozen anchor commands remain those of
`models/improvement-loop.graph.json`; the orchestrator adds none.

The root `bun run ci` command remains the canonical repository gate. Targeted
machine, boundary, and wiring tests provide narrower evidence around it.

## Residual limits accepted for this scope

- The series is single-process and journal-replayed, like the cycles it runs;
  cross-process locking is out of scope.
- Cooldown scheduling is a local executor concern; CI and the human owner
  remain the durable enforcement surfaces.
- Worker prompts are executor configuration, not model state; the model binds
  only the worker identities, kinds, retry bound, and output contract.
- The orchestrator observes cycle state by polling the persisted snapshot;
  push-based observation would require a separately modelled change.
- herdr availability is an executor prerequisite; a stopped herdr server
  surfaces as `WORKERS_FAILED`, never as fabricated evidence.
- Pausing the series while a cycle is mid-flight (for example during
  `grounding`) is not modelled; the owner cancels the cycle first, and the
  series observes `CYCLE_CANCELLED`.

No unresolved behavioral gap remains for this scope.

## Owner approval

| Field | Value |
| --- | --- |
| Approved model hash | `2770879d8c5f33a074226a0bed1fc958917efd7f5ae3a6b44fe29e2329c39e68` |
| Hash procedure | `models/improvement-orchestrator.md` § Model hash procedure |
| Approved by | human owner, 2026-08-31 |
| Scope | Implementation of the planned surface exactly as listed above |

Implementation of the planned surface proceeded under this approval. Changing
`models/improvement-orchestrator.md` or `models/improvement-orchestrator.graph.json`
invalidates this approval.
