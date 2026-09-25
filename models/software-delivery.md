# Native Software Delivery Orchestrator

## Objective

Coordinate one repository-local delivery from an adopted Product Loop task
through a separately governed Graph Engineering implementation, Product Loop
verification, reversible non-production staging, observation, and a terminal
outcome. Persist enough evidence to resume after restart and derive operational
metrics from journals.

The orchestrator owns only delivery coordination. Product Loop remains the
authority for its task, shared budget, verification, sensitive deploy review,
observation, and corrective rollback. Graph Engineering remains the authority
for its change run, exact model approval, implementation retries, and anchors.
The proposal lifecycle remains the sole authority for proposal state.

## Scope and boundaries

- The first pilot is local, single-process, and operates in this repository.
- Delivery evidence lives under `evidence/software-deliveries/`; stage state
  lives under the configured non-production stage root. Generated evidence is
  not committed.
- A Product Loop run may enter intake only in `execution`, with valid replay,
  sealed `vote-quorum` and `budget-envelope` anchors, a positive remaining
  budget, and a non-empty immutable task scope.
- The parent stores Product, Graph, and optional proposal IDs as references.
  A proposal ID is correlation only; it gives no authority and never changes
  proposal state.
- Each child is read and changed only through its public runner. The parent
  never edits child journals or snapshots and never sends a child event with
  `source: "human"`.
- Core model transitions are pure. Filesystem, clocks, workers, commands,
  Product and Graph adapters, stage operations, and telemetry are injected at
  the runtime boundary.
- This pilot never deploys to production. Missing reversible staging
  capability pauses the run in `awaitingShipCapability`.

## Roles and authority

| Node | Kind | Authority | Responsibility |
| --- | --- | --- | --- |
| `modeler` | AI worker | signal only | Draft the Graph Engineering model artifact; cannot choose states, transitions, commands, or approvals. |
| `intake-validator` | deterministic | anchor | Validate Product state, run identity, scope, sealed anchors, budget, and evidence. |
| `model-contract-validator` | deterministic | anchor | Validate the Graph model contract and compute its content hash. |
| `graph-child-adapter` | deterministic | anchor | Read and submit only through Graph Engineering; report authoritative child outcomes. |
| `product-child-adapter` | deterministic | anchor | Read and submit only through Product Loop; report authoritative child outcomes. |
| `effect-executor` | deterministic | effect | Journal and execute one bounded, authorized effect at a time. |
| `staging-target` | deterministic | anchor | Store immutable artifacts and atomically switch or restore the non-production active pointer. |
| `observer` | deterministic | anchor | Record measurements that the configured staging target actually exposes. |
| `scorecard` | deterministic | read only | Reduce durable journals into bounded metrics with explicit denominators. |

The human owner is outside the worker graph. Only the owner may resolve
unknown risk from evidence, approve or reject the exact Graph model hash,
authorize the sensitive Product Loop deploy path, or request cancellation.
Exact Graph approval is submitted through Graph Engineering. Sensitive deploy
authorization is submitted through Product Loop. The parent only verifies
the resulting child journals and snapshots.

AI signals are typed artifacts only. AI cannot vote, approve, authorize,
spend budget, waive anchors, retry, cancel, select a state, or grant a
permission. Commands are read only from the checked-in graph JSON.

## Risk and intake policy

The intake adapter derives risk from accepted Product Loop context:

1. A security category or `touchesSensitive === true` is `sensitive`.
2. An explicitly allowed non-security category with
   `touchesSensitive === false` is `standard`.
3. Missing, invalid, or conflicting evidence is `unknown`.

The adapter cannot use an AI classification to set the risk class. Unknown
risk enters `awaitingRiskReview` before Graph model preparation or any
implementation effect. A human resolution supplies evidence; the
deterministic classifier re-evaluates that evidence. It cannot downgrade a
security or sensitive task to standard. The immutable `initialRiskClass`
remains `unknown` for metrics even when evidence later resolves the current
class.

Intake rejects a Product run in any state other than `execution`, missing or
unsealed quorum/budget anchors, exhausted or malformed budget, corrupt child
journals, inconsistent run IDs, empty scope, or a proposal reference used as
authority.

## States and transitions

The parent states are coordination checkpoints, not copies of child state.
Terminal outcomes are `validated`, `rolledBack`, `failed`, `blocked`,
`cancelled`, and `rejected`.

The parent context keeps immutable Product, Graph, and optional proposal run
references; task scope and its hash; initial and resolved risk; exact Graph
model hash; implementation and artifact hashes; effect checkpoint; and
terminal outcome. It never embeds mutable child contexts.

```text
intake
  -> awaitingRiskReview | draftingGraphModel | rejected
awaitingRiskReview
  -> draftingGraphModel
draftingGraphModel
  -> validatingGraphModel
validatingGraphModel
  -> awaitingGraphApproval | failed
awaitingGraphApproval
  -> graphReady | rejected
graphReady
  -> implementing
implementing
  -> productVerification | failed | blocked | cancelled
productVerification
  -> awaitingShipReview | shipReady | blocked | failed | cancelled
awaitingShipReview
  -> shipReady | rejected | blocked
shipReady
  -> awaitingShipCapability | observing | blocked
awaitingShipCapability
  -> shipReady | blocked | cancelled
observing
  -> validated | rolledBack | failed | blocked | cancelled
```

The transition table is exhaustive. Events from the wrong source or state,
stale hashes, mismatched child IDs, duplicate evidence, and post-terminal
events are rejected and retained without advancing the parent.

| From | Event | Source / producer | Guard and result |
| --- | --- | --- | --- |
| `intake` | `INTAKE_ACCEPTED` | tool / `intake-validator` | Product Loop state and anchors are valid; unknown risk enters `awaitingRiskReview`, otherwise enter `draftingGraphModel`. |
| `intake` | `INTAKE_REJECTED` | tool / `intake-validator` | Invalid child evidence ends `rejected` with evidence. |
| `awaitingRiskReview` | `RISK_CLASSIFICATION_RESOLVED` | human / `human-owner` | Evidence is reclassified deterministically; a resolved standard or sensitive class enters `draftingGraphModel`, otherwise remains waiting. |
| `draftingGraphModel` | `GRAPH_MODEL_DRAFTED` | ai / `modeler` | Record a model artifact reference and enter `validatingGraphModel`; the event does not choose a target state. |
| `validatingGraphModel` | `MODEL_CONTRACT_VALID` | tool / `model-contract-validator` | Store the exact computed hash and enter `awaitingGraphApproval`. |
| `validatingGraphModel` | `MODEL_CONTRACT_INVALID` | tool / `model-contract-validator` | End `failed` with validation evidence. |
| `awaitingGraphApproval` | `GRAPH_APPROVAL_CONFIRMED` | tool / `graph-child-adapter` | Graph child journal and snapshot show human approval for the exact stored hash and state `ready`; enter `graphReady`. |
| `awaitingGraphApproval` | `GRAPH_APPROVAL_REJECTED` | tool / `graph-child-adapter` | Graph child journal records the owner's rejection; end `rejected`. |
| `graphReady` | `GRAPH_IMPLEMENTATION_STARTED` | tool / `graph-child-adapter` | Graph child is authoritatively `implementing`; enter `implementing`. |
| `implementing` | `GRAPH_IMPLEMENTATION_SUCCEEDED` | tool / `graph-child-adapter` | Graph child is `succeeded` with implementation hash and required anchors; enter `productVerification`. |
| Any active state | `CHILD_FAILED` | tool / Graph or Product child adapter | An authoritative child is terminal failed; end `failed` with child evidence. |
| Any active state | `CHILD_BLOCKED` | tool / Graph or Product child adapter | An authoritative child is blocked or capability/policy prevents safe continuation; end `blocked`. |
| Any active state | `CHILD_CANCELLED` | tool / Graph or Product child adapter | An authoritative child is terminal cancelled; end `cancelled` only after cancellation reconciliation. |
| `productVerification` | `PRODUCT_REVIEW_REQUIRED` | tool / `product-child-adapter` | Product is in `review` for sensitive deploy only, controls and rollback proof pass, and budget holds; enter `awaitingShipReview`. Other review reasons block this run. |
| `productVerification` | `PRODUCT_REVIEW_BLOCKED` | tool / `product-child-adapter` | Product review requires changed scope, a new budget decision, failed controls, or other work outside the approved run; end `blocked`. |
| `productVerification` | `PRODUCT_SHIP_READY` | tool / `product-child-adapter` | Product is authoritatively in `ship` after standard auto-ship gates; enter `shipReady`. |
| `awaitingShipReview` | `PRODUCT_SHIP_AUTHORIZED` | tool / `product-child-adapter` | Product journal records the human deploy review and Product state is `ship`; enter `shipReady`. |
| `shipReady` | `SHIP_CAPABILITY_MISSING` | tool / `staging-target` | No configured reversible non-production target; enter `awaitingShipCapability`. |
| `awaitingShipCapability` | `SHIP_CAPABILITY_CONFIRMED` | tool / `staging-target` | A configured target and rollback operation are independently verified; return to `shipReady`. |
| `shipReady` | `SHIP_CONFIRMED` | tool / `effect-executor` | Idempotent stage effect and active artifact hash are durably confirmed; enter `observing`. |
| `observing` | `OBSERVATION_SAMPLE_RECORDED` | tool / `observer` | Append a measured sample; stay in `observing`. Unavailable metrics are omitted, not set to zero. |
| `observing` | `OBSERVATION_VALIDATED` | tool / `product-child-adapter` | Product Loop is `validated` after its configured observation window; end `validated`. |
| `observing` | `ROLLBACK_REQUIRED` | tool / `product-child-adapter` | Product Loop has authoritatively entered rollback after its consecutive-measurement rule; remain in `observing` while effect reconciliation runs. |
| `observing` | `ROLLBACK_CONFIRMED` | tool / `staging-target` | Stage pointer was safely restored and the effect result is durable; remain in `observing` pending Product corrective-task evidence. |
| `observing` | `CORRECTIVE_TASK_OPENED` | tool / `product-child-adapter` | Confirmed rollback and Product Loop corrective proposition are both evidenced; end `rolledBack`. |
| Any active state | `CANCEL_REQUESTED` | human / `human-owner` | Record request and reconcile cancellation through each active child; do not terminalize yet. |
| Any active state | `CANCEL_SETTLED` | tool / `effect-executor` | Every child cancellation result or an explicit unreachable reason is journaled; end `cancelled`. |

## Child workflow contract

### Graph Engineering

The Graph child ID is derived deterministically from the delivery ID. Its model
is validated by the frozen contract command. The owner approves the exact
computed model hash by submitting `MODEL_APPROVED` through the Graph
Engineering CLI. The parent waits until the Graph runner independently
replays that event and reports `ready`; it never creates or forwards a
human-source signal.

The parent starts implementation only after observing Graph `ready`. It
waits for Graph `succeeded` and verifies the implementation hash and
attempt-bound required anchors before reporting the result to Product Loop.
Graph owns implementation retries and their budget.

### Product Loop

The Product child begins in `execution`, following its sealed favorable vote
quorum and budget envelope. The delivery runner charges the configured
positive per-attempt task-unit cost through Product Loop's
`budget-ledger` producer before invoking implementation. The charge is not
monetary AI cost. A rejected charge or transition to review prevents worker
invocation.

After Graph succeeds, the executor submits Product Loop's allowed
`EXECUTION_DONE` tool signal and submits verification and observation
evidence only through ProductRunner. Product Loop decides verification,
sensitive review, ship eligibility, observation outcome, rollback, and
corrective-proposition creation. A review that changes scope or budget ends
this delivery as `blocked`; the changed work requires a newly qualified
Product Loop task and a new delivery run.

Sensitive work can enter `shipReady` only after Product Loop records its
human deploy authorization, controls pass, rollback proof exists, and budget
remains. No parent event substitutes for that child decision.

## Effects, staging, and recovery

- The executor performs at most one external effect per call.
- Each effect has a stable key derived from delivery ID, effect name, and
  child attempt. The journal records intent before execution and durable result
  evidence after it.
- On restart, replay the parent and child journals, verify sequences and
  hashes, and reconcile every pending effect against child state and stage
  state before retrying. Contradictory or ambiguous non-idempotent outcomes
  block for operator review; they are never guessed from a snapshot.
- The local staging target stores immutable SHA-256 artifacts and atomically
  switches an active pointer. The empty initial pointer is the rollback
  baseline. Rollback verifies the current active hash before restoring the
  previous pointer.
- Shipping is allowed only after Product Loop enters `ship`, a reversible
  non-production capability is configured, and the registered rollback path
  is readable and restorable. No production deploy is implied by a machine
  transition.
- Require three actual clean observations and the configured observation
  window before Product Loop evaluation. Use only measured staging checks and
  host telemetry. Missing provider cost, customer, or incident data is
  unavailable and excluded from its denominator.
- Human cancellation remains non-terminal until child cancellation outcomes
  or unreachable reasons are journaled.

## Failures and forbidden transitions

- Invalid intake, malformed signals, wrong producers, stale hashes, run-ID
  mismatches, invalid journals, missing anchors, and post-terminal signals
  cannot advance the parent.
- A parent cannot infer Graph approval from Product approval, Product ship
  authorization from Graph success, or any child transition from another
  child reaching a state.
- An AI signal cannot trigger an external effect directly, forge a human
  producer, or select an outcome. Tool events must be validated against child
  journals and deterministic evidence.
- A Graph implementation failure follows Graph's bounded retry policy. The
  parent does not add a second retry policy.
- Product budget exhaustion, failed controls, permissions denial, sensitive
  review, and rollback follow Product Loop policy. The parent may block or
  wait; it cannot bypass a child gate.
- A changed task scope cannot resume under the original delivery approval.
- A single observation never causes rollback. Only Product Loop's
  consecutive-measurement policy can open it.
- A rollback without both restored stage state and a Product Loop corrective
  proposition is not a `rolledBack` terminal outcome.
- Terminal delivery outcomes are immutable.

## Durable scorecard

Rebuild scorecard data from the append-only delivery journal and linked child
journals. Show numerator, denominator, excluded/in-progress count, and
unavailable status for every rate.

- Post-approval autonomous completion: terminal runs validated by Product
  Loop with no human action after scope and exact-hash approvals, divided by
  approved runs whose Product observation window reached a terminal outcome.
- End-to-end completion: `validated` runs divided by all terminal delivery
  runs. Show each other terminal outcome separately.
- Human intervention: runs needing a human action after initial scope and
  Graph model approvals divided by runs past those approvals; separately show
  sensitive deploy review and operator recovery.
- Retry rate and count: from Graph's authoritative retry evidence.
- Control failure: runs with a failed control divided by runs reaching Product
  verification.
- Rollback: confirmed Product Loop rollback divided by shipped runs whose
  observations determined either `validated` or `rolledBack`; show pending
  and incomplete observation separately.
- End-to-end latency: intake to terminal outcome, with median and nearest-rank
  p95. Active runs are censored and reported separately.
- Capability and data coverage: configured ship adapter, observation window,
  and available cost/runtime signals.

Metrics may be dimensioned only by bounded task category, initial/resolved
risk class, time range, and terminal outcome. Never expose run IDs, proposal
IDs, paths, prompts, member identities, or voter-level measures as labels.
Missing cost or telemetry is unavailable, never zero.

## Frozen anchors

Commands are declared only in
`models/software-delivery.graph.json`. Each anchor must be present, passed,
non-empty, and bound to its applicable run or artifact:

| Anchor | Purpose |
| --- | --- |
| `delivery-model-contract` | Graph JSON, schema, state/event sets, authority map, and model hash agree. |
| `delivery-machine-tests` | Parent transitions, source checks, rollback, cancellation, replay, and regression contracts pass. |
| `delivery-architecture-contract` | Core and application dependency boundaries remain intact. |
| `rollback-path-exists` | Configured stage artifact can be read and restored before ship. |
| `delivery-runtime-scenario` | A fresh local scenario reaches validated and a separate scenario reaches rolledBack. |
| `delivery-regression` | Wrong-source, stale-hash, cross-child mutation, duplicate-effect, cancellation, and post-terminal attempts remain rejected. |
| `repository-ci` | Canonical repository CI passes before the pilot is declared complete. |

The model hash is SHA-256 over an ordered UTF-8 manifest containing each
file's SHA-256 digest, two spaces, its repository-relative path, and a newline,
in this order:

```text
models/software-delivery.md
models/software-delivery.graph.json
```

The review document and JSON Schema are not hashed. Any change to either
hashed file invalidates prior approval.
