# Swarm DAO Improvement Orchestrator (continuous series)

## Objective

Run Improvement Loop cycles **continuously** on a fixed scope and reference: a
series initializes a cycle, executes the cycle's AI workers as real coding
agents through the herdr adapter lifecycle, submits their typed signals,
executes the frozen anchor commands, submits `EVALUATE`, and — when the cycle
succeeds — schedules the next cycle. When the cycle pauses on a human gate
(`adjusting`, `retrying`) or fails, the series pauses on an explicit human
gate too. The orchestrator never gains authority over the improvement cycle,
the proposal lifecycle, or Graph Engineering runs.

This answers the residual limit recorded in `models/improvement-loop.review.md`:
"Cross-machine orchestration requires a future separately modelled change."
The orchestration is that separately modelled change; it is correlation plus
effect execution, never cross-machine state authority.

Continuity is bounded and honest: the series loops only while cycles succeed,
pauses for every human decision, halts on cycle failure, and can be cancelled
at any time. There is no state the orchestrator can reach in which an AI
output, a host adapter, or free-form text selects a cycle state, a reference
value, an anchor result, or a series transition.

## Architectural boundary

1. `packages/core/src/models/improvement-loop.machine.ts` remains the only
   authority for Improvement Loop cycle state. The orchestrator machine owns
   only the state of a **series run** (a sequence of cycles on one scope).
2. The orchestrator never emits `human`-source events to the improvement
   machine. `REFERENCE_CHANGE_APPROVED`, `REFERENCE_CHANGE_REJECTED`,
   `RETRY_AUTHORIZED`, and `CANCEL` are submitted by the human owner through
   `improvementctl` directly; the orchestrator only observes the resulting
   snapshot.
3. `improvementCycleId` correlation is immutable and one-way: the series knows
   its cycle; the cycle never learns the series.
4. The orchestrator never mutates proposal state, Graph Engineering run state,
   or Product Loop state, and never writes `.dao/`.
5. Series evidence is stored under `evidence/improvement-series/`. Generated
   evidence is not committed.
6. The executable machine lives in `packages/core/src/models` (functional
   core). herdr execution, signal submission, anchor command execution, cycle
   observation, and cooldown scheduling live outside the core model.

## Roles and graph

| Node | Kind | Authority | Responsibility |
| --- | --- | --- | --- |
| `series-machine` | state machine | series state | Own only the series run state listed below |
| `herdr-worker-executor` | deterministic tool | executor | Run one cycle AI worker (sensor, counter-sensor, drift-auditor) through the herdr workspace lifecycle; validate harvested output into a typed signal |
| `signal-submitter` | deterministic tool | executor | Submit typed signals to the improvement runner via `improvementctl` |
| `anchor-executor` | deterministic tool | executor | Run the frozen anchor commands declared in `models/improvement-loop.graph.json` and submit honest `ANCHOR_RECORDED` outcomes |
| `cycle-observer` | deterministic tool | executor | Read the persisted cycle snapshot and emit typed system observations |
| `scheduler` | deterministic tool | executor | Schedule the next-cycle cooldown; timestamps injected, never ambient |
| `human-owner` | human | gates | Start, retry workers, restart after halt, cancel; every cycle-level human decision stays with the improvement machine |

The cycle's AI workers (`sensor`, `counter-sensor`, `drift-auditor`) remain
nodes of `models/improvement-loop.graph.json`; the orchestrator executes them,
it does not own them. All nodes and edges are declared in
`models/improvement-orchestrator.graph.json`; prose cannot invent an edge.

## Workflow model

### States

```text
idle
  -> preparing                      START_SERIES (human)
  -> sampling                       CYCLE_INITIALIZED (tool)      run sensor + counter-sensor
  -> sealing                        WORKERS_HARVESTED (tool)
  -> auditing                       SAMPLES_SUBMITTED (tool)      run drift-auditor
  -> arbitrating                    WORKERS_HARVESTED (tool)
  -> grounding                      ARBITRATION_SUBMITTED (tool)  run frozen anchor commands
  -> evaluating                     ANCHORS_SUBMITTED (tool)
  -> observing                      EVALUATE_SUBMITTED (tool)
  -> cooldown                       CYCLE_SUCCEEDED (system)      schedule next cycle
  -> awaitingHumanCycleDecision     CYCLE_AWAITING_HUMAN (system)
  -> sampling                       CYCLE_RESUMED (system)        human resolved the gate
  -> preparing                      COOLDOWN_ELAPSED (system)
  -> workerFailed                   WORKERS_FAILED | SIGNAL_REJECTED (tool)
  -> halted                         CYCLE_FAILED | CYCLE_BLOCKED | CYCLE_CANCELLED (system)
  -> cancelled                      CANCEL_SERIES (human, any active state)
```

`idle` and `cancelled` are terminal. `cooldown`, `awaitingHumanCycleDecision`,
`workerFailed`, and `halted` are non-terminal states that always require a
system or human event to leave. Every submit-phase transition
(`sealing`, `auditing`, `arbitrating`, `grounding`, `evaluating`) exists only
to sequence effects between observations; none of them decides cycle state.

### Events and permitted sources

| Event | Source | From | To / effect |
| --- | --- | --- | --- |
| `START_SERIES` | `human` | `idle` | `preparing`; effect INIT_CYCLE(scope, referenceHash, cooldownMs) |
| `CYCLE_INITIALIZED` | `tool` | `preparing` | `sampling`; effect RUN_WORKERS(sensor, counter-sensor) |
| `WORKERS_HARVESTED` | `tool` | `sampling` | `sealing`; effect SUBMIT_SAMPLES(validated signals) |
| `WORKERS_HARVESTED` | `tool` | `auditing` | `arbitrating`; effect SUBMIT_DRIFT(validated signal) |
| `SAMPLES_SUBMITTED` | `tool` | `sealing` | `auditing`; effect RUN_WORKERS(drift-auditor) |
| `ARBITRATION_SUBMITTED` | `tool` | `arbitrating` | `grounding`; effect RUN_ANCHOR_COMMANDS(frozen list) |
| `ANCHORS_SUBMITTED` | `tool` | `grounding` | `evaluating`; effect SUBMIT_EVALUATE |
| `EVALUATE_SUBMITTED` | `tool` | `evaluating` | `observing`; effect OBSERVE_CYCLE |
| `CYCLE_SUCCEEDED` | `system` | `observing` | `cooldown`; effect SCHEDULE_NEXT_CYCLE |
| `CYCLE_AWAITING_HUMAN` | `system` | `observing` | `awaitingHumanCycleDecision`; effect OBSERVE_CYCLE (poll) |
| `CYCLE_RESUMED` | `system` | `awaitingHumanCycleDecision` | `sampling`; effect RUN_WORKERS(sensor, counter-sensor) |
| `CYCLE_FAILED` | `system` | `observing` | `halted`; record reason |
| `CYCLE_BLOCKED` | `system` | `observing` | `halted`; record reason |
| `CYCLE_CANCELLED` | `system` | `observing` | `halted`; record reason |
| `COOLDOWN_ELAPSED` | `system` | `cooldown` | `preparing`; effect INIT_CYCLE(next sequence number) |
| `WORKERS_FAILED` | `tool` | `sampling`, `auditing` | `workerFailed`; record phase and reason |
| `SIGNAL_REJECTED` | `tool` | `sealing`, `arbitrating` | `workerFailed`; record the runner's issues |
| `RETRY_WORKERS` | `human` | `workerFailed` | the recorded failed phase; effect RUN_WORKERS(that phase) |
| `RESTART_SERIES` | `human` | `halted` | `preparing`; effect INIT_CYCLE(next sequence number) |
| `CANCEL_SERIES` | `human` | any active state | `cancelled`; record reason |

Events from the wrong source or state are rejected and journaled. Free-form
text is never converted into a human event. A rejected or blocked herdr agent
is an error, never a signal.

### Observation mapping

The cycle-observer maps the persisted improvement snapshot to exactly one
typed observation:

| Cycle state | Observation |
| --- | --- |
| `succeeded` | `CYCLE_SUCCEEDED` |
| `adjusting`, `retrying` | `CYCLE_AWAITING_HUMAN` |
| back to `sampling` after a human cycle event | `CYCLE_RESUMED` |
| `failed` | `CYCLE_FAILED` |
| `blocked` | `CYCLE_BLOCKED` |
| `cancelled` | `CYCLE_CANCELLED` |
| any other active state | no observation (poll continues) |

## Side effects

- INIT_CYCLE: `improvement:init` with the series scope and reference hash;
  cycle id is `<seriesId>-c<sequence>`; the sequence increments per cycle.
- RUN_WORKERS: for each worker, the herdr lifecycle (workspace create → agent
  start → prompt --wait → read → workspace close), kind configured (default
  `pi`), bounded executor retries (two) with a fresh workspace per attempt;
  harvested output validated into a typed improvement signal.
- SUBMIT_*: `improvementctl submit` with the validated signal files; accepted
  and rejected submissions are both journaled.
- RUN_ANCHOR_COMMANDS: execute only the commands declared in
  `models/improvement-loop.graph.json`; submit one honest `ANCHOR_RECORDED`
  per command outcome (a failed anchor is submitted as failed, never retried
  by the orchestrator).
- OBSERVE_CYCLE: read the cycle snapshot; no write.
- SCHEDULE_NEXT_CYCLE: schedule `COOLDOWN_ELAPSED` after the configured,
  non-zero, injected cooldown; the machine never reads a clock.
- Append every accepted and rejected orchestrator signal to an NDJSON journal
  and persist the series snapshot after every event; restore by deterministic
  journal replay.

## Invariants

1. Only an XState machine changes Improvement Orchestrator series state.
2. The orchestrator never submits a `human`-source event to any machine; every
   human cycle decision is taken by the owner through `improvementctl`, and
   the orchestrator only observes its result.
3. The improvement machine remains the only cycle authority: the orchestrator
   cannot select a cycle state, supply a reference value, produce or waive
   anchor evidence, or override arbitration.
4. AI worker output reaches the machine only as a typed signal validated by
   the existing improvement signal validator; unparseable, blocked, or timed-out
   workers end in `workerFailed`, never in a fabricated sample.
5. Anchor commands come only from the frozen improvement graph JSON.
6. Worker executor retries are effect-level, bounded (two), and idempotent
   (fresh workspace per attempt); they never change series or cycle state.
7. One active series per scope; a series cannot start while another is active
   for the same scope.
8. `cancelled` and `idle` are terminal and reject every later event.
9. Series state never mutates proposal, Graph Engineering, Product Loop, or
   Improvement cycle state; correlation is immutable and one-way.
10. Core-model purity rules apply: no filesystem, network, ambient clock,
    randomness, host SDK, or async orchestration in the machine.

## Model hash procedure

From the repository root, the validator computes individual SHA-256 digests in
this exact order, serializes each as `<digest><two spaces><relative path>\n`,
then hashes the resulting UTF-8 manifest with SHA-256:

```text
models/improvement-orchestrator.md
models/improvement-orchestrator.graph.json
```

The review file and the graph schema are not part of the model hash. Changing
either hashed model file invalidates any earlier approval.

## Planned implementation surface after approval

- `packages/core/src/models/improvement-orchestrator.machine.ts` and public
  model export through `packages/core/src/models/index.ts`.
- `tools/improvement-loop/orchestrator.ts` (series CLI: `init`, `status`,
  `submit`, `once`) and `tools/improvement-loop/workers.ts` (herdr worker
  executor reusing the herdr adapter lifecycle helpers).
- Root scripts for `improvement:series:init`, `improvement:series:status`,
  `improvement:series:submit`, and `improvement:series:once`.
- Machine, boundary, and wiring tests under `packages/core/tests/` and
  `tools/improvement-loop/tests/`.
- `.gitignore` coverage for `evidence/improvement-series/`.
- A short index entry in `models/README.md`.

No implementation file may be added or changed before the owner approves the
exact model hash.
