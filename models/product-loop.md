# Swarm DAO Continuous Product-Loop

## Objective

Evolve the existing proposal/task/voting workflow from human-triggered steps into
a controlled **automatic product loop** that can qualify, vote, execute, ship,
observe, validate, and roll back changes — without ever letting an LLM, a host
adapter, or free-form text decide a state transition, and without auto-deploying
sensitive changes.

The product loop is the authority for one *product-loop run*. It never mutates
Swarm DAO proposal state, Graph Engineering run state, or Improvement Loop cycle
state. Correlation IDs (`proposalId`, `improvementCycleId`) are immutable and
one-way.

The design follows the same rule as the rest of the repository: **if the
behavior cannot be modelled, it is not ready to be implemented; if a state
transition depends on an LLM, the architecture is incorrect. The LLM produces
signals. The model decides.**

## Architectural boundary

1. `packages/core/src/models/product-loop.machine.ts` is the only authority for
   product-loop run state. It is pure: no I/O, no ambient clock, no randomness,
   no `async`, no `node:` imports (enforced by `architecture.contract.test.ts`).
2. `packages/core/src/models/proposal.machine.ts` remains the only authority for
   Swarm DAO proposal state. The product loop never emits proposal events and
   never writes `.dao/`.
3. `packages/core/src/models/graph-engineering.machine.ts` remains the only
   authority for repository change-control runs. The product loop never emits
   graph-engineering events.
4. `packages/core/src/models/improvement-loop.machine.ts` remains the only
   authority for self-improvement cycles. A product loop may carry an immutable
   `improvementCycleId` correlation; it grants no permission and causes no
   transition in that machine.
5. The machine stores local evidence under `evidence/product-loops/`. Generated
   evidence is not committed.
6. Filesystem persistence, command execution, scheduling, and clock reads live
   outside the core model — in the tool adapter. Timestamps are injected as
   event payloads and as deterministic evaluation inputs, never read inside the
   machine.

## Roles and graph

| Node | Kind | Authority | Responsibility |
| --- | --- | --- | --- |
| `explorer` | AI worker | signal only | Open-ended product work; emits exploration notes and agent signals that may become propositions |
| `feedback-aggregator` | AI worker | signal only | Aggregate anonymous user feedback into a proposition draft; never reveal identity |
| `proposer` | AI worker | signal only | Structure a proposition draft (scope, category, sensitive flag) |
| `proposition-gate` | deterministic tool | anchor | Promote a recorded draft into a tracked proposition; never drafts or selects a target on its own |
| `qualifier` | deterministic tool | anchor | Validate scope, dependencies, permissions, allowed category, and budget presence |
| `vote-tally` | deterministic tool | anchor | Count favorable votes; compute quorum; never accepts an AI-cast vote |
| `budget-ledger` | deterministic tool | anchor | Track the shared task envelope: initial, consumed, remaining, action history; blocks at zero |
| `verifier` | deterministic tool | anchor | Run tests/controls; record pass/fail with durable evidence |
| `observation-gate` | deterministic tool | anchor | Measure errors, AI cost, latency over the observation window; require consecutive confirmations |
| `rollback-opener` | deterministic tool | anchor | Open a corrective proposition after confirmed degradation |
| `contact-relay` | deterministic tool | anchor | Relay contact only after a dedicated DAO vote AND final member consent |

The human owner is outside the worker graph. Only the owner may expand the
budget, reduce scope, abandon a task, authorize a verification retry, override
to Review, or cancel a run. All nodes and edges are declared in
`models/product-loop.graph.json`; prose cannot invent an edge.

## Workflow model

### States

```text
exploration
  -> proposition
  -> qualification
  -> vote
  -> adopted | rejected
adopted -> execution
execution -> verification | budgetBlocked
verification -> ship | review
ship -> observation
observation -> validated | rollback
rollback -> proposition            (auto-opens a corrective proposal)
budgetBlocked -> review            (deterministic `always` escalation; only outgoing edge)
review                            (human-gated; non-terminal; leaves only on REVIEW_RESOLVED)
```

`validated` and `rejected` are terminal. `budgetBlocked` has exactly one outgoing
edge: it escalates to `review` immediately and deterministically (no event
needed, no bypass). `review` is non-terminal and always requires a human event
to leave. `rollback` is non-terminal and always transitions to `proposition`.

The shared budget envelope opens automatically on `adopted → execution` (the
`openBudget` action seals `initial`/`consumed`/`remaining`); there is no
separate budget-opened event.

### Events and permitted sources

| Event | Source | From | To / effect |
| --- | --- | --- | --- |
| `AGENT_SIGNAL` | `ai` | `exploration` | Record an agent signal that may seed a proposition |
| `FEEDBACK_AGGREGATED` | `ai` | `exploration` | Record an aggregated anonymous feedback draft |
| `PROPOSAL_DRAFTED` | `ai` | `exploration` | Record a structured proposition draft (signal only; never a transition) |
| `OPEN_PROPOSITION` | `tool` | `exploration` | `proposition`; seal the proposition from the recorded draft |
| `QUALIFICATION_RUN` | `tool` | `proposition` | `qualification` if all deterministic criteria pass; otherwise `review` |
| `VOTE_OPENED` | `tool` | `qualification` | `vote`; record vote config (expiry, quorum, kind) |
| `VOTE_CAST` | `tool` | `vote` | Record one favorable vote (the tool maps a human vote to a deterministic tally input; AI cannot cast) |
| `VOTE_EVALUATE` | `system` | `vote` | `adopted` on quorum reached; otherwise stays in `vote` until expiry |
| `VOTE_EXPIRED` | `tool` | `vote` | `rejected` when expiry passes without quorum |
| `BUDGET_CHARGE` | `tool` | `execution` | Record a charge against the shared envelope; routes to `budgetBlocked` at zero |
| `EXECUTION_DONE` | `tool` | `execution` | `verification` only when budget remains; otherwise `budgetBlocked` |
| `VERIFY_RUN` | `tool` | `verification` | Record control results |
| `VERIFY_EVALUATE` | `system` | `verification` | `ship` if all controls pass, change is allowed/reversible, rollback exists, budget remains, and not sensitive; otherwise `review` |
| `OBSERVATION_SAMPLE` | `tool` | `ship`/`observation` | Record one measurement (errors, aiCost, latency, satisfaction) |
| `OBSERVATION_EVALUATE` | `system` | `observation` | `validated` at end of window without confirmed degradation; `rollback` on confirmed degradation |
| `CORRECTIVE_PROPOSITION_OPENED` | `tool` | `rollback` | `proposition`; auto-open the corrective proposal |
| `REVIEW_RESOLVED` | `human` | `review` | `proposition` (scope-reduced), `execution` (budget-expanded; ONLY when `reviewReason === "budget-exhausted"` and must carry `expandedBudget > consumed`), `ship` (deploy-authorized; ONLY for sensitive changes that passed verification with all ship-gate anchors and budget holding), or terminal `rejected` (abandoned) per the resolution kind |
| `RETRY_VERIFICATION_AUTHORIZED` | `human` | `review` | `verification`; re-run controls after a human decision |
| `CONTACT_VOTE_OPENED` | `tool` | any active state | Open a dedicated contact-permission vote (normal quorum) |
| `CONTACT_RELAY_AUTHORIZED` | `human` | any active state | Relay contact only after the contact vote reached quorum AND final member consent |
| `PERMISSION_DENIED` | `tool` | any active state | `review` (sensitive intervention) |
| `CANCEL` | `human` | any active state | `rejected` (cancelled runs are terminal) |

Events from the wrong source or wrong state are rejected and journaled.
Free-form text is never parsed into a human event.

### Deterministic policies (live in the machine; called by the tool adapter)

1. **Qualification** — `qualifyProposal(draft, permissionsCleared)`:
   passes iff `scope` non-empty, `category ∈ allowedCategories`,
   `dependencies` resolvable, `permissionsCleared === true` (an explicit,
   evidence-backed boolean carried by `QUALIFICATION_RUN` — qualification never
   passes on the mere absence of a denial), and `budget` allocated.
   Sensitive security proposals may pass qualification (they are auto-votable)
   but are flagged `touchesSensitive`, which later forbids auto-ship.

2. **Vote tally** — `tallyVotes(cast, config)`:
   `quorumReached = favorableCount ≥ config.quorum`. The quorum is a *minimum
   favorable-vote threshold*, not participation. `VOTE_EVALUATE` selects
   `adopted` the instant quorum is reached; otherwise the run stays in `vote`
   until `VOTE_EXPIRED`, which selects `rejected`. Standard expiry = 72h;
   critical-security corrective expiry = 12h. The expiry is supplied by the
   tool as a deterministic input; the machine never reads a clock.

3. **Budget ledger** — `applyBudgetCharge(envelope, charge)`:
   `remaining = initial − consumed`; `remaining < 0` is clamped to 0 and the
   next `BUDGET_CHARGE`/`EXECUTION_DONE` routes to `budgetBlocked`. The ledger
   records `initial`, `consumed`, `remaining`, and an append-only action
   history. It never ranks contributors.

4. **Auto-ship gate** — `canAutoShip(context)`:
   passes iff every control `passed`, `allowedCategory === true`,
   `reversible === true`, `rollbackArtifact` non-empty, `remaining > 0`, and
   `touchesSensitive === false`. Sensitive security work routes to `review`
   for human deploy authorization via `canHumanAuthorizeSensitiveDeploy`, which
   additionally requires the externally recorded `rollback-path-exists` anchor.

5. **Observation gate** — `evaluateObservation(window)`:
   priorities are `errors > aiCost > latency`. A single measurement never
   rolls back. Degradation is confirmed only when **N consecutive**
   measurements cross the configured threshold for the highest-priority
   metric that is breached. Validation additionally requires at least **N**
   samples recorded (an empty or sub-threshold window never validates). User
   satisfaction is recorded but can never directly select `rollback`; it is
   aggregated as a product signal.

6. **Feedback anonymity** — feedback is anonymous by default. Contact relay
   requires (a) a dedicated contact-permission vote that reached the normal
   quorum and (b) a final `CONTACT_RELAY_AUTHORIZED` human event. Identity is
   never revealed unless both hold.

### Required anchors

Every anchor must be present, `passed`, non-empty, and bound to the current
product-loop run. The frozen commands live in `models/product-loop.graph.json`
and are executed only by the tool adapter. An AI signal cannot provide or
replace a command.

1. `qualification-passed` — scope, dependencies, permissions, allowed category,
   and budget all validated deterministically.
2. `vote-quorum` — the favorable-vote tally reached the configured quorum (or
   expiry was reached without it).
3. `budget-envelope` — the shared task envelope is present and non-negative.
4. `controls-passed` — every required test/control passed with durable
   evidence.
5. `auto-ship-policy` — the deterministic auto-ship gate ran and recorded its
   decision.
6. `observation-window` — the observation window elapsed with measurements
   recorded.
7. `rollback-path-exists` — a rollback artifact/command is registered for the
   shipped change. This is an **external** anchor: it is recorded by the
   verifier tool (`product:anchors`) via `ANCHOR_RECORDED` after confirming the
   rollback artifact is genuine, not self-sealed by the ship action. It is a
   ship-gate prerequisite.
8. `frozen-set-intact` — the frozen rules the optimizer is never allowed to
   tune are unchanged this run.
9. `regression` — the independent counter-metric proves that AI-sourced
   adoption, waived controls, unfreezing, and self-approved deploys remain
   impossible.

## Side effects

- Append every accepted and rejected signal to an NDJSON journal.
- Persist the current XState snapshot after every submitted signal.
- Compute model and reference hashes outside AI workers.
- Keep all core model actions pure; timestamps are injected by the evidence
  adapter and are not transition guards.
- A project-local scheduler or Stop hook may block while an active run is
  non-terminal. The hook reads the snapshot; it does not decide state.

## Invariants

1. Only an XState machine changes product-loop run state.
2. Run signals cannot contain `nextState`, `targetState`, `transition`, vote
   tallies, budget decisions, anchor commands, approval, retry authorization,
   cancellation, or permission grants.
3. AI events cannot name a target state, cast a vote, decide a budget, provide
   a command, approve work, authorize a retry, cancel, grant permissions, or
   reveal a member identity.
4. A proposition cannot leave `qualification` unless the deterministic
   qualification policy passed (or it routes to `review`).
5. A vote cannot reach `adopted` without the configured favorable-vote quorum;
   it cannot reach `rejected` except on expiry.
6. An adopted task cannot enter `execution` without a sealed shared budget
   envelope.
7. `execution` cannot reach `verification` at zero remaining budget; it routes
   to `budgetBlocked`.
8. `verification` cannot reach `ship` unless every control passed, the change
   is allowed/reversible, the externally recorded `rollback-path-exists` anchor
   is present, budget remains, and the change is not sensitive. Otherwise it
   routes to `review`. Sensitive changes can only reach `ship` from `review`
   via a human `deploy-authorized` resolution that satisfies
   `canHumanAuthorizeSensitiveDeploy` (all controls passed, allowed/reversible,
   rollback anchor present, budget holding).
9. `observation` cannot reach `rollback` on a single measurement; it requires
   N consecutive measurements crossing the deterministic threshold.
10. `observation` cannot reach `validated` with fewer than N recorded samples;
    an empty or sub-threshold observation window never validates.
11. A vote at expiry with quorum reached must adopt; a vote at expiry without
    quorum must reject. A duplicate `VOTE_OPENED` never resets an existing tally.
12. User satisfaction feedback can never directly select `rollback`; it is
    aggregated as a product signal only.
13. Member identity is never revealed unless a dedicated contact-permission
    vote reached quorum AND a final human consent event was emitted.
14. `budgetBlocked` has exactly one outgoing edge: an immediate, deterministic
    escalation to `review` (no event, no bypass, no contributor swap, no
    automatic budget increase). Only a human `REVIEW_RESOLVED` can leave `review`.
15. No agent may unilaterally decide a state transition. `REVIEW_RESOLVED`,
    `RETRY_VERIFICATION_AUTHORIZED`, `CONTACT_RELAY_AUTHORIZED`, and `CANCEL`
    are human-only.
16. Terminal states reject every later event.
17. Product-loop status never changes a Swarm DAO proposal status, a Graph
    Engineering run status, an Improvement Loop cycle status, or any other
    machine's state; correlation is immutable and one-way.
16. Existing core-model purity rules apply: no filesystem, network, ambient
    clock, randomness, host SDK, or async orchestration in the machine.

## Model hash procedure

From the repository root, the validator computes individual SHA-256 digests in
this exact order, serializes each as `<digest><two spaces><relative path>\n`,
then hashes the resulting UTF-8 manifest with SHA-256:

```text
models/product-loop.md
models/product-loop.graph.json
```

The review file and the graph schema are not part of the model hash. Changing
either hashed model file invalidates any earlier approval.

## Planned implementation surface after approval

- `packages/core/src/models/product-loop.machine.ts` and public model export
  through `packages/core/src/models/index.ts`.
- Repository-local run signal validation, evidence journal, deterministic
  replay, validator, CLI, and a reference scenario under `tools/product-loop/`.
- Machine, policy, regression, and frozen-contract tests under
  `packages/core/tests/`.
- Root scripts for `product:validate`, `product:anchors`,
  `product:regression`, and a reference scenario.
- `.gitignore` coverage for generated run evidence.
- A short index entry in `models/README.md`.

No implementation file may be added or changed before the owner approves the
exact model hash.
