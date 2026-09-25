# Review: Native Software Delivery Orchestrator

## Decision

Behavioral review for the repository-local pilot. Implementation is gated on
human approval of the exact hash of
`models/software-delivery.md` and
`models/software-delivery.graph.json` through Graph Engineering. Spec
approval alone does not authorize that model hash.

## Coverage

| Concern | Model coverage | Decision |
| --- | --- | --- |
| Product intake | Requires Product `execution`, sealed quorum and budget anchors, remaining budget, valid journals, run IDs, and non-empty scope | Covered |
| Proposal lifecycle | Optional immutable correlation only; no `.dao/` or proposal state authority | Covered |
| Graph child authority | Exact hash approval and implementation state read from Graph's own runner | Covered |
| Product child authority | Budget, verification, sensitive deploy, ship, observation, and rollback remain Product Loop decisions | Covered |
| Unknown risk | Evidence-backed human resolution before model preparation; deterministic reclassification; initial unknown remains measurable | Covered |
| Sensitive work | Cannot auto-ship; requires Product Loop's human deploy review and rollback proof | Covered |
| Standard work | Requires Product auto-ship gates and a reversible non-production target | Covered |
| Invalid evidence | Wrong source/state, malformed input, stale hash, mismatched IDs, corrupt journal, and missing anchors do not advance | Covered |
| Effect recovery | Durable intent/result keys; reconcile ambiguous effects before retry; never guess | Covered |
| Budget | Charge through Product's budget ledger before implementation; no worker after rejection or budget review | Covered |
| Observation | Actual configured-window measurements; three clean samples before Product evaluation; unavailable data omitted | Covered |
| Rollback | Product consecutive-measurement rule, restored stage pointer, and corrective proposition required | Covered |
| Cancellation | Human request; parent terminalizes only after child results or unreachable reasons are recorded | Covered |
| Scorecard | Explicit numerators, denominators, exclusions, terminal outcomes, latency, retries, controls, rollback, and coverage | Covered |
| Privacy | No IDs, paths, prompts, identities, or voter metrics as scorecard labels | Covered |
| Core purity | Machine contains no I/O, filesystem, clock, randomness, async effects, or host SDK | Covered |

## Transition review

1. The parent has no path from intake to implementation without validated
   Product evidence, a valid delivery model, and Graph's exact-hash approval.
2. Unknown risk cannot reach model preparation until a human supplies evidence
   and the deterministic policy resolves it.
3. Graph implementation cannot start until Graph Engineering itself is
   authoritatively in `ready`.
4. Product execution results are submitted through ProductRunner only after
   Graph Engineering is `succeeded` with implementation hash and anchors.
5. Standard ship eligibility comes from Product Loop's `ship` state after
   its auto-ship gates. Sensitive ship eligibility additionally requires the
   Product Loop human review path.
6. Missing ship capability pauses visibly. It cannot become a successful
   simulated deploy.
7. Observation validation and rollback follow Product Loop evidence and
   transitions. One sample cannot directly select rollback.
8. The parent records `rolledBack` only after stage restoration and
   corrective proposition evidence are both present.
9. Cancellation does not become terminal until each active child has a
   journaled result or an explicit reason it could not be reached.
10. Rejected or malformed signals are retained without a state transition;
    terminal delivery states are immutable.

## Forbidden transitions

- Product approval cannot authorize Graph model approval or implementation.
- Graph success cannot authorize Product deploy or mutate Product state.
- The parent cannot edit a child context, journal, or snapshot.
- AI output cannot submit human events, charge budget, waive anchors, retry,
  cancel, select target states, or execute commands.
- Unknown risk cannot default to standard; sensitive risk cannot be reduced
  by a human label without deterministic evidence.
- A changed task scope cannot reuse the original Graph approval or delivery
  run.
- A non-reversible or production target cannot be configured as the pilot
  ship capability.
- Missing metrics cannot be represented as zero or counted as an observation.
- Ambiguous external effects cannot be repeated without reconciliation.
- An incomplete rollback cannot be reported as a successful rollback.

## Residual limits accepted for this scope

- The pilot is single-process and local; it does not claim cross-process locks
  or distributed execution.
- Staging measurements represent the declared local target, not customer or
  production health.
- Provider cost and customer/incident data may remain unavailable.
- Existing Product Loop and Graph Engineering behavior is reused without
  changing either child machine.
- Builder.io Factory is not used.

No unresolved transition or authority gap is accepted for implementation.
