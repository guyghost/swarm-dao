# Native Software Delivery Orchestration

## Status

Conversational design approved. Written spec awaiting owner review. No product
code or implementation plan is authorized by this document alone.

## Goal

Add a repository-native, restartable delivery flow that coordinates the
existing governance, Graph Engineering, Product Loop, and verification
capabilities for a change in this repository. The flow should make it possible
to measure how much of each task completed without operational intervention,
how often safeguards stopped or rolled back a change, and how long delivery
took.

The pilot runs in this repository first. It preserves the existing machine
boundaries and exposes a host-independent core so later repository or host
adapters can be added without moving policy into shell scripts.

## Existing capabilities and gaps

- The proposal machine owns proposal lifecycle state. Its states and outcomes
  are not owned by Graph Engineering, Product Loop, or a new coordinator.
- Graph Engineering owns a change run, requires human approval of the exact
  reviewed model hash, runs bounded implementation retries, and evaluates
  declared deterministic anchors.
- Product Loop owns a product task from qualification and favorable-vote
  quorum through budgeted execution, verification, ship review, observation,
  and corrective rollback. Sensitive changes cannot auto-ship.
- Improvement Orchestrator runs observation and audit workers. It does not
  implement application code.
- Each runner journals its own accepted and rejected signals and can replay
  its machine. Existing process metrics do not provide durable delivery-run
  rates or cross-run denominators.
- Product Loop's current CLI only initializes, reads, and submits signals. No
  existing runtime coordinates it with Graph Engineering or performs a full
  delivery effect sequence.

`models/product-loop.review.md` expressly leaves cross-machine orchestration
for a separately modelled change. This design supplies that parent model; it
does not extend or replace the child machines.

## Chosen approach

Add a small, pure XState **Delivery Orchestrator** model and a repository-local
executor. The model owns only parent coordination state, run references,
effect checkpoints, and terminal delivery outcomes. A journaled executor
performs I/O and submits valid events through each child runner's public API.
Each child machine remains the sole authority for its state and policy.

This approach adds the missing durable parent truth while keeping effects out
of `packages/core`. A shell-only script would lose reliable recovery state; a
Product Loop extension would violate its documented boundary and couple two
independent authorities.

## Authorities and intake

1. The pilot starts from a Product Loop task that has completed its own
   qualification and favorable-vote quorum and is in `execution`. The
   machine's `adopted` state immediately opens the budget and transitions to
   `execution`, so the executor verifies sealed quorum evidence and an active
   budget envelope rather than requiring an observable `adopted` snapshot.
   The native Product Loop vote is the execution-governance prerequisite.
2. A legacy proposal ID may be attached as immutable correlation. Its status
   does not mutate Product Loop or Delivery Orchestrator state. The
   coordinator never copies a proposal approval into a Product Loop vote.
3. Graph Engineering must independently validate its model and receive an
   explicit human `MODEL_APPROVED` event whose hash exactly matches the model
   under review. The coordinator cannot create this human event, infer it from
   another vote, or authorize implementation itself.
4. Delivery Orchestrator may request effects only after reading authoritative
   child snapshots and checking the expected state and run ID. It submits
   signals as the appropriate deterministic tool/system producer; human-only
   decisions remain human-only.
5. Product Loop retains its own shared budget, verification, sensitivity,
   ship, observation, and rollback rules. Graph Engineering retains its
   implementation and anchor rules. Improvement runs may be correlated for
   reporting only; they are not an execution authority.

An intake without a Product Loop run in `execution`, sealed quorum evidence, an
active budget envelope, a valid run reference, or a known change scope is
rejected or held for review. Risk classification is conservative: security
category or `touchesSensitive === true` is `sensitive`; an explicitly
qualified allowed non-security category with a false sensitive flag is
`standard`; missing, invalid, or conflicting evidence is `unknown`. Only
Product Loop's accepted, validated context may establish the first two
classes. Unknown risk pauses before automated implementation until its
classification is resolved from verifiable evidence; it never defaults to
standard. A structured human resolution may supply missing evidence, but the
deterministic policy reclassifies it and cannot permit a security or sensitive
change to become standard. The run retains its initial `unknown` label for
metrics. Sensitive work may be implemented under its adopted budget but
requires human deploy review before shipping.

## Components and boundaries

### Delivery Orchestrator model

Add a model and graph contract under `models/` and its pure machine under
`packages/core/src/models/`. Its states describe coordination only, with a
nominal path equivalent to:

```text
intake -> draftingGraphModel (standard or sensitive classification)
intake -> awaitingRiskReview (unknown classification)
awaitingRiskReview -> intake (verified classification supplied)
draftingGraphModel -> validatingGraphModel
validatingGraphModel -> awaitingGraphApproval
awaitingGraphApproval -> graphReady (exact human approval recorded by Graph Engineering)
graphReady -> implementing
implementing -> productVerification
productVerification -> awaitingShipReview | shipReady
awaitingShipReview -> shipReady (human deploy authorization)
shipReady -> observing (ship effect confirmed)
shipReady -> awaitingShipCapability (no configured ship target)
awaitingShipCapability -> observing (ship effect confirmed after resume)
observing -> validated | rolledBack | failed | blocked | cancelled | rejected
```

The exact state and event names must be kept consistent across the model,
review, graph JSON, machine, and signal contract during implementation. The
parent records child IDs, expected child states, the approved model hash,
implementation hash, and durable effect status. It does not embed child
contexts as mutable parent state.

Human approval, sensitive deploy authorization, cancellation, and any other
human-only actions require structured human-source events. AI workers may
return drafts, implementation artifacts, or bounded classifier results; they
cannot choose a state, authorize work, submit votes, waive anchors, spend
budget, approve deploy, retry, cancel, or grant permission.

### Repository executor and child adapters

Place filesystem, clock, command, worker, and network effects outside core,
under a repository-local `tools/software-delivery/` entry point or equivalent
package boundary. The executor:

- reads and validates the Product Loop and Graph Engineering snapshots;
- runs one bounded effect at a time and records an intent/result checkpoint;
- submits child signals only through their runners, never through direct actor
  mutation or by editing child snapshots;
- invokes only commands declared by the relevant checked-in graph contract;
- derives hashes and evidence from deterministic tools, not AI claims;
- exposes init/status/submit/once (advance one safe effect)/resume commands;
- emits a reviewable delivery artifact and complete evidence references.

The delivery journal is authoritative for coordination and KPI aggregation;
each child's existing journal remains authoritative for that child's events.
Each parent effect carries a stable idempotency key. On restart, the executor
reconciles the effect checkpoint with child snapshots and journals before
retrying. If it cannot determine whether a non-idempotent ship effect
completed, it stops in review instead of repeating the effect.

The first pilot is local and single-process, using the repository's existing
journal-and-replay conventions. It does not introduce distributed locking,
remote execution, cross-process workers, or a new proposal database. A parent
run ID is the stable correlation key across parent and child evidence.

### Product Loop ship and observation adapter

The Product Loop machine provides the policy gates; the executor supplies the
real tool evidence and side effects. No production deploy is implied by an
XState transition. The first host must declare its actual ship target and
rollback operation in deterministic configuration. Until a reversible,
non-production target and its rollback path are configured, the flow stops at
the ship gate and reports `awaiting-capability`; it does not simulate a
successful deploy or fabricate customer/runtime observations. Sensitive
deploys still require the Product Loop's human review path.

Observations use measurements available from that declared target. Missing
cost, customer, or external incident data is represented as unavailable and
is excluded from the relevant denominator; it is never recorded as zero.
Local build/test evidence is reported as local verification, not production
health.

## Data and event flow

1. Intake records the Product Loop run ID, verifies its sealed adoption/quorum
   evidence and active budget envelope, then records optional legacy proposal
   correlation ID, delivery task, repository identity, and immutable scope
   hash. It checks the Product Loop snapshot and its own journal before any
   implementation effect.
2. The modeler drafts the Graph Engineering model. A deterministic validator
   validates the model and computes its exact content hash. The executor
   creates the Graph run with a stable ID derived from the delivery run,
   records that child ID and hash, and waits for the owner to approve it
   through Graph Engineering.
3. After Graph Engineering is authoritatively in `ready`, the executor starts
   the Graph run and enters its bounded implementation loop. Product Loop's
   adopted task already owns its budget envelope; deterministic budget tools
   remain the only source of budget charges.
4. The Graph runner records implementation signals, hashes, and anchor
   results. The parent advances only after Graph Engineering is terminal
   `succeeded`; failed, blocked, or cancelled graph outcomes are propagated as
   delivery outcomes with evidence, not rewritten.
5. The executor reports completion through Product Loop's valid tool signal,
   runs Product Loop controls and ship-gate anchors against the resulting
   artifact, and submits their results through ProductRunner. The Product Loop
   machine determines review or ship eligibility. If its review resolves to a
   reduced scope, expanded budget, or retry outside the sensitive deploy path,
   the parent pauses the current run; the changed scope requires a newly
   qualified Product Loop task and a new delivery run before implementation
   resumes.
6. For `standard` tasks, a configured ship adapter may act only when the
   Product Loop machine has entered `ship`. For `sensitive` tasks, the flow
   waits for the machine's structured human deploy authorization. Unknown
   tasks cannot reach this step until their risk was resolved before
   implementation. The adapter records a durable effect result before
   observation starts.
7. The observer records available measurements through Product Loop signals.
   Product Loop alone determines whether the observation window validates the
   change or whether its consecutive-measurement rollback rule opens rollback
   and a corrective proposition. For this deployment instance, the parent
   records `rolledBack` only after the rollback and corrective proposition are
   both confirmed; the follow-on corrective delivery starts as a new parent
   run after its Product Loop task reaches execution.
8. The parent consumes child snapshots and journals, records the terminal
   delivery outcome, and updates a derived scorecard by replaying its journal.

No child event is inferred from another child reaching a state. The parent
coordinates explicit effects and records references to the evidence that
justifies each decision.

## Failure, retries, and recovery

- A rejected or malformed signal is recorded with producer, event type,
  reason, and unchanged before/after states. It never advances the parent.
- A Graph implementation failure follows Graph Engineering's bounded retry
  policy. The parent does not issue a second retry policy or let an AI worker
  authorize retries.
- A Product Loop budget block, failed control, permission denial, sensitive
  gate, or rollback follows the Product Loop machine. The parent reflects the
  child result and can request human review, but cannot bypass it. A confirmed
  rollback closes this deployment instance as `rolledBack`; the Product Loop
  corrective proposition remains a separate child task.
- Human cancellation is a structured parent event and must also submit
  permitted cancellation events to active children. The parent is not terminal
  until it has journaled each child cancellation result or a reason the child
  could not be reached.
- Restart replays the parent journal and child journals, validates sequence
  and hashes, and reconciles snapshots. Corrupt or contradictory evidence
  moves the parent to blocked/review; no state is guessed from a snapshot
  alone.
- Retry limits, timeouts, and worker-turn limits are fixed in validated
  configuration and recorded per run. Changing those limits cannot silently
  change an active run.

## Durable operational metrics

Metrics are derived per delivery run from the append-only parent journal and
linked child journal references. They are not kept only in the process-local
`packages/core/src/observability/metrics.ts` aggregates. The scorecard is
rebuildable and every counted outcome links to evidence.

Report active runs separately from terminal denominators. For each time range
and resolved risk class (`standard`, `sensitive`, `unknown`), report the count
of tasks initially classified `unknown` separately, and report:

- **Post-approval autonomous completion rate:** terminal runs that reach
  Product Loop `validated` with no human intervention after all required
  scope and exact-hash approvals, divided by runs with those approvals whose
  Product Loop observation window has reached a terminal outcome.
- **End-to-end completion rate:** validated terminal runs divided by all
  terminal delivery runs; also show rolled-back, failed, blocked, cancelled,
  and rejected counts. This prevents required governance approvals from
  making the post-approval automation measure meaningless.
- **Human intervention rate:** runs requiring any human action after initial
  scope and Graph model approvals divided by runs past those approvals;
  separately count sensitive deploy review and operator recovery.
- **Retry rate and count:** runs with at least one retry and total retries,
  from Graph's authoritative retry evidence.
- **Control failure rate:** runs with one or more failed controls divided by
  runs reaching Product Loop verification.
- **Rollback rate:** runs with confirmed Product Loop rollback divided by
  shipped runs with enough observation to determine a validated or rolled-back
  outcome. Also report pending/incomplete observation separately.
- **End-to-end latency:** elapsed time from parent intake to terminal outcome,
  with median and p95. Active runs are censored and reported separately.
- **Capability/data coverage:** configured ship adapter, observation window,
  and available cost/runtime signals; unavailable values are displayed as
  unavailable, never zero.

The scorecard must show numerator, denominator, and excluded/in-progress
counts. A metric with no eligible observations is `unavailable`, not 0%.
Metric dimensions are bounded to known task category/risk class and outcome;
proposal IDs, run IDs, paths, prompts, and member identities are not metric
labels. No individual voter identity is added to the scorecard.

## Security and permission boundaries

- Commands and checks come from checked-in model/graph contracts, not AI
  output, proposal text, or a journal payload.
- Every child signal is validated by the owning adapter and machine. The
  parent cannot spoof a `human` producer.
- Exact-hash Graph approval binds the implementation to the reviewed
  governance model. Any model-file change invalidates the approval.
- Sensitive and unknown changes cannot auto-ship. Product Loop human deploy
  authorization remains a separate structured event after verification and
  rollback-path proof.
- Secrets, full prompts, personal data, and member identity are excluded from
  metric labels and public status summaries. Journals store only the evidence
  required for audit and replay.

## Verification plan

Implementation must establish deterministic contracts for the parent model,
signal-source and state validation, child-authority preservation,
idempotent effect recovery, journal replay, and terminal behavior. A reference
scenario should demonstrate a standard task from Product Loop adoption through
exact Graph model approval, implementation, verified ship adapter, observation,
and validation. Separate scenarios should demonstrate stale model approval,
unknown risk, sensitive human review, budget exhaustion, failed controls,
rollback, cancellation, duplicate effect recovery, unavailable measurements,
and contradictory journals.

The implementation must run the frozen anchors declared by the models and the
repository's canonical `bun run ci` gate before claiming the pilot complete.
This spec stage does not run checks or add tests.

## Rollout and acceptance criteria

The first release is opt-in and local to this repository. Existing proposal,
Graph Engineering, Product Loop, and Improvement Loop commands retain their
current meaning. The delivery CLI requires an explicit Product Loop run
reference, creates a stable Graph run ID from the parent delivery ID, and
prints current child states, required human actions, effect checkpoints, and
evidence paths.

The pilot is acceptable when:

1. one parent run can be resumed after process restart without duplicate
   child transitions or ship effects;
2. the parent advances only from authoritative child outcomes and preserves
   each machine's source/state guards;
3. the owner must approve the exact Graph model hash, and required Product
   Loop human gates cannot be bypassed;
4. standard, sensitive, and unknown risk routes follow the policy above;
5. a configured, reversible non-production target can reach observation and
   Product Loop validation, while missing capability stops visibly;
6. the scorecard is reproducible from journals and reports explicit
   denominators, terminal outcomes, latency, retries, control failures,
   rollback, and unavailable data;
7. tests, contracts, documentation, anchors, and repository CI validate the
   new boundary without a regression in existing child workflows.

## Non-goals

- Replacing the existing proposal lifecycle or transferring its authority.
- Changing Product Loop, Graph Engineering, or Improvement Loop behavior
  without a separately reviewed model change and exact-hash approval where
  required.
- Production deployment, cross-repository automation, distributed workers,
  and remote/multi-host execution in the first pilot.
- Inferring demand or user satisfaction from AI estimates, treating missing
  telemetry as zero, or including personally identifying voter metrics.
- Using Builder.io Factory or making the Factory skill part of the workflow.
