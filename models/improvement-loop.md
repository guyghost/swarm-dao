# Swarm DAO Improvement Loop

## Objective

Provide a self-improvement layer above the proposal lifecycle that proves the
DAO's optimization metrics remain **grounded** — that the numbers the system
drives still touch the world they claim to describe. Each *improvement cycle*
samples a metric and its required counter-metric, audits the metric for drift,
arbitrates any conflict between paired signals deterministically, verifies
frozen ground-contact anchors, and either succeeds (grounded) or enters a
human-gated reference adjustment. The cycle can never succeed on AI judgment
alone, and a metric can never travel without its counter-metric.

The design follows the loop-to-graph argument: a single optimizing loop fails
in four characteristic ways (Goodhart, blindness upward, conflict, measurement
decay). Each failure is answered topologically by a node in the cycle graph,
and the whole graph is anchored against reality by frozen measurements and an
external human judgment that no arrangement of edges can supply.

The pilot succeeds when a cycle can move from sampled signals to a verified
grounded outcome through an XState machine, typed signals, frozen runtime
anchors, a deterministic arbitration policy, and durable evidence — without the
AI ever selecting a target state, a reference value, or an anchor result.

## Architectural boundary

1. `packages/core/src/models/proposal.machine.ts` remains the only authority for
   Swarm DAO proposal states. The Improvement Loop machine never emits proposal
   events and never writes `.dao/`.
2. `packages/core/src/models/graph-engineering.machine.ts` remains the only
   authority for repository change-control runs. The Improvement Loop machine
   owns only the state of a self-improvement *cycle run*.
3. A cycle may carry an immutable `proposalId` or `scope` correlation value, but
   that value grants no permission and causes no transition in any other
   machine.
4. The machine stores local evidence under `evidence/improvement-cycles/`.
   Generated evidence is not committed.
5. The executable machine will live in `packages/core/src/models` so it obeys
   the existing functional-core boundary. Filesystem persistence, command
   execution, and scheduling live outside the core model.

## Roles and graph

| Node | Kind | Authority | Responsibility |
| --- | --- | --- | --- |
| `sensor` | AI worker | signal only | Sample the optimizing metric |
| `counter-sensor` | AI worker | signal only | Sample the paired counter-metric (Goodhart pairing) |
| `sample-gate` | deterministic tool | anchor | Seal the pair only when both samples are present and non-empty |
| `drift-auditor` | AI worker | signal only | Estimate whether the metric still corresponds to reality (measurement decay) |
| `arbitrator` | deterministic tool | anchor | Resolve conflict between paired signals via a fixed policy (conflict) |
| `anchor-verifier` | deterministic tool | anchor | Run frozen ground-contact anchors and the regression counter-metric |

The human owner is outside the worker graph. Only the owner approves or rejects
a reference change, owns the frozen set, authorizes a retry, or cancels a cycle.
All nodes and edges are declared in `models/improvement-loop.graph.json`; prose
cannot invent an edge. The `reference-owner` role (the slower loop that holds
target values) is represented by the human owner: target values enter the cycle
only through a human `REFERENCE_CHANGE_APPROVED` event.

## Mapping to the loop-to-graph argument

| Single-loop failure | Topological answer in this cycle |
| --- | --- |
| Goodhart — a measure optimized hard enough stops measuring what it did | `counter-sensor` + `sample-gate`: a metric cannot leave sampling without its paired counter-metric (anchor `counter-metric-paired`) |
| Blindness upward — a loop cannot question its own reference | The human owner is the reference owner; revising a target is itself a governed cycle through the `adjusting` state |
| Conflict — independently-built loops fight | `arbitrator` owns the paired-metric trade-off deterministically; AI cannot override it (anchor `arbitration-policy`) |
| Measurement decay — sensors drift and detach from reality | `drift-auditor` plus anchor `drift-audit`; a `detached` estimate forces `adjusting`, never `succeeded` |
| Graph circularity — loops that only watch loops | Frozen `anchor-reality` and `frozen-set-intact` anchors that touch the world, and an external human judgment at the root |

## Workflow model

### States

```text
sampling
  -> auditing
  -> arbitrating
  -> grounding
  -> evaluating
  -> succeeded | adjusting | retrying | failed | blocked | cancelled
```

`succeeded`, `failed`, `blocked`, and `cancelled` are terminal. `adjusting` and
`retrying` are non-terminal states that always require a human event to leave.

### Events and permitted sources

| Event | Source | From | To / effect |
| --- | --- | --- | --- |
| `METRIC_SAMPLED` | `ai` | `sampling` | Record the optimizing metric sample |
| `COUNTER_SAMPLED` | `ai` | `sampling` | Record the counter-metric sample |
| `SAMPLES_SEALED` | `tool` | `sampling` | `auditing` only when both samples are present and non-empty |
| `DRIFT_ESTIMATE` | `ai` | `auditing` | `arbitrating`; record the drift class as a signal only |
| `ARBITRATION` | `tool` | `arbitrating` | `grounding`; record the deterministic arbitration outcome |
| `ANCHOR_RECORDED` | `tool` | `grounding` | Record one immutable anchor result for the current attempt |
| `EVALUATE` | `system` | `grounding` | `succeeded`, `adjusting`, `retrying`, or `failed` per anchors, drift, and retry budget |
| `REFERENCE_CHANGE_APPROVED` | `human` | `adjusting` | `sampling`; apply the new reference and clear cycle evidence |
| `REFERENCE_CHANGE_REJECTED` | `human` | `adjusting` | `failed`; record the reason |
| `RETRY_AUTHORIZED` | `human` | `retrying` | `sampling`; increment attempt and clear attempt-scoped evidence |
| `PERMISSION_DENIED` | `tool` | any active state | `blocked` |
| `CANCEL` | `human` | any active state | `cancelled` |

Events from the wrong source or state are rejected and journaled. Free-form
text is never converted into a human event. The drift class is a signal: a
`none` estimate never alone satisfies grounding, because ground-contact anchors
are still required.

### EVALUATE decision

`EVALUATE` selects exactly one outcome, in this order:

1. If the drift class is `detached`, the cycle is not grounded regardless of
   other evidence: target is `adjusting` (human must review the reference or
   the frozen set).
2. Else if every required anchor is `passed`, non-empty, and bound to the
   current attempt, target is `succeeded`.
3. Else if `attempt < maxRetries`, target is `retrying`.
4. Else target is `failed`.

### Required ground-contact anchors

Every anchor must be present, `passed`, non-empty, and bound to the current
attempt. The `counter-metric-paired` and `frozen-set-intact` anchors are bound
to the reviewed model hash and survive an authorized retry.

1. `counter-metric-paired` — the optimizing metric's paired counter-metric was
   sampled and is non-empty. A metric never travels alone.
2. `drift-audit` — the drift auditor produced a bounded estimate with durable
   evidence.
3. `arbitration-policy` — deterministic arbitration ran on the paired signals
   and recorded its outcome.
4. `anchor-reality` — a frozen ground-truth check that cannot be argued with
   passed (for example: a shipped artifact hash exists, or a persisted
   executed-count matches its source).
5. `frozen-set-intact` — the set of frozen rules the optimizer is never allowed
   to tune is unchanged this cycle.
6. `regression` — the independent counter-metric proves that AI-sourced success,
   waived counter-metrics, unfreezing, and self-approved reference changes
   remain impossible.

The frozen commands are declared in `models/improvement-loop.graph.json` and
executed only by the tool adapter. An AI signal cannot provide or replace a
command.

## Side effects

- Append every accepted and rejected signal to an NDJSON journal.
- Persist the current XState snapshot after every submitted signal.
- Compute model and reference hashes outside AI workers.
- Keep all core model actions pure; timestamps are injected by the evidence
  adapter and are not transition guards.
- On retry, retain the approved model hash, the `counter-metric-paired` and
  `frozen-set-intact` evidence, and the reference, but clear all other
  attempt-scoped evidence.
- A project-local scheduler or Stop hook may block while an active cycle is
  non-terminal. The hook reads the snapshot; it does not decide state.

## Invariants

1. Only an XState machine changes Improvement Loop cycle state.
2. Cycle signals cannot contain `nextState`, `targetState`, `transition`,
   `reference`/`target` values, anchor commands, approval, retry authorization,
   cancellation, or permission grants.
3. `REFERENCE_CHANGE_APPROVED.referenceHash` must exactly match the reviewed
   reference hash for the current scope.
4. A cycle cannot leave `sampling` without both the metric and its counter-metric
   sampled (Goodhart).
5. A cycle cannot reach `succeeded` without all six required anchors passed for
   the current attempt.
6. A `detached` drift estimate can never produce `succeeded`; it forces
   `adjusting`.
7. Reference (target) values are owned by the human owner; AI signals never
   carry target values (blindness upward).
8. Frozen anchor commands come only from the graph JSON; the implementer cannot
   produce, replace, or waive anchor evidence.
9. Arbitration is deterministic and owns the paired-metric trade-off; AI cannot
   override arbitration (conflict).
10. A failed anchor cannot be overwritten in the same attempt.
11. Evidence from one attempt cannot satisfy a later attempt.
12. Retries are bounded to two and always require a human event.
13. Permission denial and cancellation are explicit terminal outcomes.
14. Terminal states reject every later event.
15. Improvement Loop status never changes a Swarm DAO proposal status, a Graph
    Engineering run status, or any other machine's state; correlation is
    immutable and one-way.
16. Existing core-model purity rules apply: no filesystem, network, ambient
    clock, randomness, host SDK, or async orchestration in the machine.

## Model hash procedure

From the repository root, the validator computes individual SHA-256 digests in
this exact order, serializes each as `<digest><two spaces><relative path>\n`,
then hashes the resulting UTF-8 manifest with SHA-256:

```text
models/improvement-loop.md
models/improvement-loop.graph.json
```

The review file and the graph schema are not part of the model hash. Changing
either hashed model file invalidates any earlier approval.

## Planned implementation surface after approval

- `packages/core/src/models/improvement-loop.machine.ts` and public model export
  through `packages/core/src/models/index.ts`.
- Repository-local cycle signal validation, evidence journal, deterministic
  replay, validator, CLI, and a successful reference scenario under
  `tools/improvement-loop/`.
- Machine, arbitration, frozen-set, and regression tests under
  `packages/core/tests/`.
- Root scripts for `improvement:validate`, `improvement:anchors`,
  `improvement:regression`, and a reference scenario.
- `.gitignore` coverage for generated cycle evidence.
- A short index entry in `models/README.md`.

No implementation file may be added or changed before the owner approves the
exact model hash.
