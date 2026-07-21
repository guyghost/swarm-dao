# Review: Swarm DAO Improvement Loop

## Decision

The behavioral model is complete and ready for an explicit owner decision on
its exact hash. Implementation remains forbidden until that approval event is
provided.

## Coverage

| Concern | Model coverage | Decision |
| --- | --- | --- |
| Nominal path | Sample, paired counter-metric, drift audit, arbitration, six anchors, evaluation | Covered |
| Existing proposal lifecycle | Separate authority; immutable optional correlation only | Covered |
| Graph Engineering runs | Separate authority; no cross-machine transition | Covered |
| Goodhart (metric gaming) | Counter-metric is mandatory; `sample-gate` seals the pair; anchor `counter-metric-paired` | Covered |
| Blindness upward | Human owns the reference; `adjusting` is a governed, human-gated state | Covered |
| Conflict | Deterministic `arbitrator` owns the paired-metric trade-off; anchor `arbitration-policy` | Covered |
| Measurement decay | `drift-auditor` plus anchor `drift-audit`; `detached` forces `adjusting` | Covered |
| Graph circularity | Frozen `anchor-reality` and `frozen-set-intact`; external human root judgment | Covered |
| Invalid input | Schema and source guards reject and journal it | Covered |
| Stale approval | Reference hash must equal the current reviewed reference hash | Covered |
| Errors | Exhausted attempts and rejected reference changes end in `failed` | Covered |
| Cancellation | Human `CANCEL` is accepted from every active state | Covered |
| Retries | Human authorization, maximum two, attempt-scoped evidence | Covered |
| Permissions | Tool-reported denial ends explicitly in `blocked` | Covered |
| Terminal behavior | Four explicit terminal states reject all later events | Covered |
| Counter-metrics | `regression` anchor is an independent mandatory veto | Covered |
| Evidence decay | Every anchor requires durable, non-empty, attempt-bound evidence | Covered |
| LLM boundary | AI emits samples and drift estimates only; no state, reference, anchor, or arbitration authority | Covered |
| Hexagonal boundary | Machine remains pure; I/O and scheduling remain outside core | Covered |

## Transition review

1. No transition is driven by free-form text.
2. Human events are structured, and reference change is bound to an exact
   SHA-256 hash.
3. AI events cannot name a target state, supply a reference value, provide
   commands, approve work, arbitrate, authorize a retry, cancel, or grant
   permissions.
4. Tool events seal the sample pair, arbitrate, record anchors, or deny
   permission; they never adopt an AI estimate as ground truth.
5. System events evaluate existing evidence; they do not manufacture evidence.
6. Wrong-source, wrong-state, malformed, duplicate-anchor, and post-terminal
   events are rejected and retained in the journal.
7. The drift estimate never alone selects an outcome; `detached` forces
   `adjusting` and every other class still requires the ground-contact anchors.

## Invariant review

- There is no path from `sampling` to `succeeded` that bypasses the paired
  counter-metric, arbitration, and all six anchors.
- `EVALUATE` has no success path when an anchor is missing, failed, empty, or
  belongs to another attempt, and no success path when drift is `detached`.
- A metric cannot leave `sampling` without its counter-metric.
- A reference value cannot enter the cycle except through a human event.
- Arbitration cannot be overridden by an AI signal.
- A failed anchor is immutable for the current attempt.
- A retry keeps the approved model, the counter-metric pairing, the frozen-set
  evidence, and the reference, but clears other attempt-scoped evidence.
- The regression and frozen-set anchors cannot be replaced by the implementer.
- Permission denial cannot silently become a retry.
- Improvement Loop state cannot mutate proposal or Graph Engineering state.
- Core-model purity is protected by the existing architecture contract tests.

## Implementation review

The planned implementation reuses the repository's XState dependency and the
existing `packages/core/src/models` source-of-truth convention. It adds a
repository-local tool adapter rather than extending `.dao/state.json`, so the
cycle does not introduce a storage migration or a second proposal workflow.

The root `bun run ci` command remains the canonical repository gate. Targeted
machine, arbitration, frozen-set, anchor, and regression tests provide narrower
evidence around it. The frozen anchor commands are declared in the graph JSON
and materialize during implementation; they are not supplied by any AI signal.

## Residual limits accepted for this scope

- Anchors prove local repository and packaged outcomes, not production or
  customer reality. The `anchor-reality` command must name a genuinely external
  artifact (a shipped hash, a persisted count) to keep contact with the world.
- Scheduling is a local guardrail; CI remains the durable enforcement surface.
- Cycles are single-process and journal-replayed. Cross-process locking and
  distributed execution are outside this scope.
- Linking a cycle to a proposal or a Graph Engineering run is correlation only.
  Cross-machine orchestration requires a future separately modelled change.
- The drift auditor is an AI worker; its estimate is treated strictly as a
  signal and can never alone determine ground contact.

No unresolved behavioral gap remains for this scope.
