# Review: Swarm DAO Continuous Product-Loop

## Decision

The behavioral model is complete and ready for an explicit owner decision on
its exact hash. Implementation remains forbidden until that approval event is
provided. This review covers nominal paths, errors, cancellations, retries,
permissions, terminal states, allowed/forbidden transitions, and invariants.

## Coverage

| Concern | Model coverage | Decision |
| --- | --- | --- |
| Nominal path | Exploration → Proposition → Qualification → Vote → Adopted → Execution → Verification → Ship → Observation → Validated | Covered |
| Rejected path | Vote expiry without quorum reaches terminal `rejected` | Covered |
| Rollback loop | Confirmed degradation (N consecutive measurements) → Rollback → auto-opens corrective Proposition | Covered |
| Budget exhaustion | `execution → budgetBlocked → review` only; no bypass, no contributor swap | Covered |
| Sensitive deploy | Auto-qualified and auto-votable, but `Verification → Ship` forbidden when `touchesSensitive`; routes to `review` | Covered |
| Quorum semantics | Quorum = minimum favorable-vote threshold (not participation); `adopted` the instant quorum reached, `rejected` only on expiry | Covered |
| Vote expiry | Standard 72h; critical-security corrective 12h; supplied as deterministic input, never read from a clock inside the machine | Covered |
| Member quota | 5-hour (300 min) renewable non-transferable quota per member; exploration unlimited; enforced by the budget-ledger tool, not the machine | Covered |
| Shared task envelope | After adoption: one shared envelope (initial/consumed/remaining/history); no contributor ranking | Covered |
| Observation priorities | errors > AI cost > latency; user satisfaction is aggregated signal only, never directly selects rollback | Covered |
| Consecutive measurements | Single measurement never rolls back; N=3 consecutive threshold-crossings required | Covered |
| Feedback anonymity | Anonymous by default; contact relay requires dedicated quorum vote AND final human consent | Covered |
| Existing proposal lifecycle | Separate authority; immutable optional correlation only | Covered |
| Graph Engineering runs | Separate authority; no cross-machine transition | Covered |
| Improvement loops | Separate authority; immutable optional correlation only | Covered |
| Invalid input | Schema and source guards reject and journal it | Covered |
| Stale approval | Model hash is computed from the two hashed model files; any change invalidates earlier approval | Covered |
| Errors | Failed controls, sensitive change, or budget exhaustion route to `review`; abandoned tasks end in terminal `rejected` | Covered |
| Cancellation | Human `CANCEL` is accepted from every active state and ends in terminal `rejected` | Covered |
| Retries | Human `RETRY_VERIFICATION_AUTHORIZED` from `review` returns to `verification`; bounded and human-gated | Covered |
| Permissions | Tool-reported denial routes to `review` (sensitive intervention) | Covered |
| Terminal behavior | `validated` and `rejected` are terminal and reject all later events | Covered |
| Counter-metrics | `regression` anchor is an independent mandatory veto | Covered |
| Evidence decay | Every anchor requires durable, non-empty, run-bound evidence | Covered |
| LLM boundary | AI emits signals, drafts, classifications, extractions, enrichments only; never a state target, vote, budget, command, approval, retry, cancel, permission, or identity | Covered |
| Hexagonal boundary | Machine remains pure; I/O, scheduling, and clock reads remain outside core | Covered |

## Transition review

1. No transition is driven by free-form text.
2. Human events are structured and bound to the reviewed model hash.
3. AI events cannot name a target state, cast a vote, decide a budget, provide
   a command, approve work, arbitrate, authorize a retry, cancel, grant
   permissions, or reveal a member identity.
4. Tool events qualify, tally votes, charge the budget, record controls,
   sample observations, open corrective propositions, and open contact votes;
   they never adopt an AI estimate as ground truth.
5. System events (`VOTE_EVALUATE`, `VERIFY_EVALUATE`,
   `OBSERVATION_EVALUATE`) evaluate existing evidence deterministically; they
   do not manufacture evidence.
6. Wrong-source, wrong-state, malformed, duplicate-anchor, and post-terminal
   events are rejected and retained in the journal.
7. `VOTE_EVALUATE` selects `adopted` only when `favorableCount ≥ quorum`;
   otherwise the run stays in `vote` until `VOTE_EXPIRED` selects `rejected`.
8. `VERIFY_EVALUATE` selects `ship` only when every control passed, the change
   is allowed/reversible, a rollback exists, budget remains, and the change is
   not sensitive; otherwise it routes to `review`.
9. `OBSERVATION_EVALUATE` selects `validated` only at end of window without
   confirmed degradation; it selects `rollback` only on N consecutive
   threshold-crossing measurements.

## Allowed transitions

```text
exploration      -> proposition          (OPEN_PROPOSITION/tool)
proposition      -> qualification        (QUALIFICATION_RUN/tool, passed)
proposition      -> review               (QUALIFICATION_RUN/tool, failed)
qualification    -> vote                 (VOTE_OPENED/tool)
vote             -> adopted              (VOTE_EVALUATE/system, quorum reached)
vote             -> rejected             (VOTE_EXPIRED/tool, no quorum)
adopted          -> execution            (automatic: openBudget action seals the envelope)
execution        -> verification         (EXECUTION_DONE/tool, budget remains)
execution        -> budgetBlocked        (BUDGET_CHARGE/tool, zero remaining)
verification     -> ship                 (VERIFY_EVALUATE/system, auto-ship gate)
verification     -> review               (VERIFY_EVALUATE/system, gate failed)
ship             -> observation          (OBSERVATION_SAMPLE/tool, first sample)
observation      -> validated            (OBSERVATION_EVALUATE/system, clean window)
observation      -> rollback             (OBSERVATION_EVALUATE/system, confirmed)
rollback         -> proposition          (CORRECTIVE_PROPOSITION_OPENED/tool)
budgetBlocked    -> review               (deterministic always; only outgoing edge)
review           -> proposition          (REVIEW_RESOLVED/human, scope-reduced)
review           -> execution            (REVIEW_RESOLVED/human, budget-expanded)
review           -> verification         (RETRY_VERIFICATION_AUTHORIZED/human)
review           -> rejected             (REVIEW_RESOLVED/human, abandoned)
any active       -> rejected             (CANCEL/human)
any active       -> review               (PERMISSION_DENIED/tool)
```

## Forbidden transitions

- `budgetBlocked → execution` directly (budget bypass forbidden).
- `verification → ship` when `touchesSensitive === true` (sensitive deploy
  forbidden without human review).
- `observation → rollback` on a single measurement (consecutive rule).
- `observation → rollback` from user-satisfaction feedback alone (signal only).
- `vote → adopted` from participation alone (favorable quorum required).
- Any AI-source event selecting a target state, casting a vote, charging the
  budget, approving a deploy, opening a rollback, or revealing an identity.
- Any cross-machine mutation of proposal, graph-engineering, or
  improvement-loop state.

## Invariant review

- There is no path from `exploration` to `validated` that bypasses
  qualification, the favorable-vote quorum, the shared budget envelope, every
  control, the auto-ship gate, and the observation window.
- `VOTE_EVALUATE` has no adoption path when the favorable count is below
  quorum.
- `VERIFY_EVALUATE` has no ship path when a control failed, the change is not
  allowed/reversible, no rollback exists, budget is exhausted, or the change
  is sensitive.
- `OBSERVATION_EVALUATE` has no rollback path without N consecutive
  threshold-crossing measurements.
- A member identity cannot be revealed unless a dedicated contact vote reached
  quorum AND a final human consent event was emitted.
- `budgetBlocked` has exactly one outgoing edge: `review`.
- Permission denial cannot silently become a retry or a ship.
- Product-loop state cannot mutate proposal, graph-engineering, or
  improvement-loop state.
- Core-model purity is protected by the existing architecture contract tests.

## Implementation review

The planned implementation reuses the repository's XState dependency and the
existing `packages/core/src/models` source-of-truth convention. It adds a
repository-local tool adapter rather than extending `.dao/state.json`, so the
loop does not introduce a storage migration or a second proposal workflow.

The root `bun run ci` command remains the canonical repository gate. Targeted
machine, policy, regression, frozen-set, anchor, and contract tests provide
narrower evidence around it. The frozen anchor commands are declared in the
graph JSON and materialize during implementation; they are not supplied by any
AI signal.

## Residual limits accepted for this scope

- Anchors prove local repository and packaged outcomes, not production or
  customer reality. The `rollback-path-exists` anchor must name a genuine
  rollback artifact (a deployed hash, a migrations-down command) to keep
  contact with the world.
- Scheduling is a local guardrail; CI remains the durable enforcement surface.
- Runs are single-process and journal-replayed. Cross-process locking and
  distributed execution are outside this scope.
- Linking a run to a proposal, a Graph Engineering run, or an improvement
  cycle is correlation only. Cross-machine orchestration requires a future
  separately modelled change.
- The 5-hour member quota is enforced by the budget-ledger tool adapter; the
  machine models only the shared task envelope after adoption.
- Exploration is unlimited by design; no quota is modelled for the
  `exploration` state.

No unresolved behavioral gap remains for this scope.
