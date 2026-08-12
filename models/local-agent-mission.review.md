# Review: Local Agent Mission for macOS — M1

## Subsequent implementation authorization

On 2026-08-12, the coordinator relayed explicit human approval of the reviewed
model hash below and explicitly requested the Implement → Verify phases. The
ordered model manifest remains unchanged; this note is outside that manifest.

## Original Model/Review decision

The Model and Review scope is complete. The behavioral contract is ready for an
explicit human decision on its exact hash. **Implementation is not authorized
by this review**: no SwiftUI/AppKit code, executable XState machine,
application/API service, persistence adapter, or process orchestration was
added.

Reviewed source of truth:

- `models/local-agent-mission.md`
- `models/local-agent-mission.graph.json`
- `models/local-agent-mission.graph.schema.json`

Reviewed model hash:
`9b6613df9f584ef8bc33cf0a274f539b7e3513fc48e642c9fd825dd03d1a88d6`.

## Repository fit

| Repository convention | Review result |
| --- | --- |
| Behavioral truth lives under `/models` | Satisfied |
| Important workflows use XState v5 | Four XState v5 machines are specified for the future Implement phase |
| Executable models live in `packages/core/src/models` | Preserved; that directory was not changed during Model/Review |
| Pure functional core, I/O through ports/adapters | Required by the effect protocol and global invariant `INV-12` |
| AI emits signals; models decide | Required by authority metadata, event-source allowlists, and `INV-02`/`INV-03` |
| Existing proposal/workflow authorities remain separate | Satisfied; correlations convey no authority |
| Existing DFI delegation lifecycle remains separate | Satisfied; useful concepts are retained without reusing the wrong aggregate authority |

## Coverage matrix

| Concern | Evidence in model | Decision |
| --- | --- | --- |
| Native local M1 boundary | Platform metadata and `INV-13`; adapters/catalogue/setup assistant are deferred | Covered |
| Nominal mission path | `M02` launch seals snapshot, `M03` activates, `M14` completes | Covered |
| Draft editing and ownership | `M01`; owner and structured-draft guard | Covered |
| Team templates | Append-only revisions, built-in immutability, save and duplicate rules | Covered |
| Immutable launch snapshot | Snapshot entity, launch guards, `INV-04` | Covered |
| Structured autonomy contract | Six mandatory dimensions; missing facts fail closed | Covered |
| Shared human/agent thread | Message aggregate, `M10`/`M20`, thread/card data separation | Covered |
| Future visibility field | Envelope supports `mission_shared` and `direct`; M1 explicitly rejects direct | Covered |
| Agent technical detail | Agent record and redacted append-only activity journal | Covered |
| Mission pause/resume | `M06`/`M22`/`M07`; `paused` requires restartable quiescence | Covered |
| Human intervention | Agent signal `M08`, cross-machine blocker `M21`, resolution `M11`–`M13` | Covered |
| Agent lifecycle | `A01`–`A27`, including startup, activity, human wait, interruption, retries, completion, failure, cancellation | Covered |
| Subagent nominal path | `M09`, `S01`/`S02`/`S07`/`S08` | Covered |
| Subagent denial visibility | `S04`, `S06`, `S10`, `S13` append visible refusal/failure notices | Covered |
| Parent/child lineage | `INV-05`, `X01`–`X04`; immutable same-mission parent id | Covered |
| Parent stopping descendants | `A12`–`A16`, `A22`–`A24`, `X04`; descendants-first and explicit absence evidence | Covered |
| Three policy levels | Immutable ceilings, field-aware global rules, exact mission overrides | Covered |
| Explicit mission override confirmation | `O01`–`O05`, exact diff fingerprint and authenticated owner | Covered |
| Override expiry | `O06`, mission terminal effects, `INV-07` | Covered |
| Override dependency safety | `O07` and `X09` forbid removal while live work depends on an override | Covered |
| Permission denial | Deterministic canonical-fact policy result with stable reason code | Covered |
| File permissions | Separate canonical read/write roots; symlink/path uncertainty fails closed | Covered |
| Global policy revision during a mission | Every new action uses a recorded revision; tightening affects uncommitted work and relaxation cannot widen the sealed contract | Covered |
| Budget concurrency | Atomic reservation/consumption and idempotent effect keys | Covered |
| Automatic retries | Explicit finite retry states, structured error codes, injected deadlines | Covered |
| Human-gated retries | `AGENT_RETRY_AUTHORIZED`/`SUBAGENT_RETRY_AUTHORIZED`; exact attempt/evidence binding | Covered |
| Non-retryable/exhausted errors | Explicit agent/request failure and mission blocker/fatal paths | Covered |
| Cancellation | `M15`–`M19`, `S12`, `A13`; requests/overrides/descendants handled before terminal mission state | Covered |
| Crash recovery | Atomic snapshot/journal/outbox commit, acknowledgements, launch/stop tokens, idempotency | Covered |
| Terminal behavior | Terminal lists on every machine; post-terminal rejection; `INV-09` | Covered |
| Wrong source/state/input | Explicit rejection policy and append-only decision journal | Covered |
| LLM boundary | Only `AGENT_SIGNAL_RECORDED` has AI source; `INV-16` confines model calls to dedicated AI workers | Covered |
| Secrets and chain-of-thought | Excluded from thread and activity persistence | Covered |

## Transition review

Transitions that share one state/event pair form ordered, mutually exclusive
guard sets. The future machine and tests must prove both exclusivity and the
declared rejection when no branch matches.

| Branch set | Exhaustive modeled outcomes |
| --- | --- |
| `pending + MISSION_ACTIVATION_EVALUATED` | all required active; needs human; still starting (`M03`–`M05`) |
| `human_intervention_required + MISSION_INTERVENTION_EVALUATED` | resolved to active; resolved to pending; blockers remain (`M11`–`M13`) |
| `pausing + MISSION_PAUSE_QUIESCENCE_EVALUATED` | reach `paused` only after agent/start-intent quiescence (`M22`) |
| `starting + PROCESS_START_FAILED` | automatic retry; terminal failure; human-gated retry (`A03`, `A04`, `A25`) |
| running agent + `PROCESS_EXITED` | expected completion; automatic retry; terminal/fatal failure; human-gated retry (`A09`–`A11`, `A26`) |
| `stopping + PROCESS_STOPPED/LOCAL_PROCESS_ABSENT` | restartable interruption or terminal cancellation (`A15`, `A16`, `A22`, `A23`) |
| `stopping + PROCESS_STOP_FAILED` | bounded retry or explicit failure (`A17`, `A19`) |
| `requested + POLICY_VALIDATION_REQUESTED` | validate or visible refusal (`S01`, `S13`) |
| `policy_validating + POLICY_FACTS_RECORDED` | allow; confirmation required; deny (`S02`–`S04`) |
| `starting + CHILD_AGENT_FAILED` | automatic retry; terminal failure; human-gated retry (`S09`, `S10`, `S15`) |
| `ceiling_check + OVERRIDE_FACTS_RECORDED` | await confirmation or reject (`O02`, `O03`) |
| `awaiting_confirmation + human decision` | exact confirmation activates; exact decline rejects (`O04`, `O05`) |

The following are deliberately rejections rather than self-transitions:

- mission completion evaluation before all completion invariants hold;
- direct/private message submission in M1;
- a stale process acknowledgement or stale policy fingerprint;
- an unconfirmed policy relaxation;
- a subagent start after parent/mission activity or policy has changed;
- any unknown, malformed, wrong-source, wrong-state, or post-terminal event.

## Scenario review

### Nominal scenarios

1. A built-in template is adjusted in a draft, launched, and sealed without
   mutating the built-in revision.
2. Required local agents start; the mission becomes active; humans and agents
   append shared messages.
3. Agent technical activity appears only on its card, not in the shared thread.
4. An active parent requests a policy-compliant child; policy facts validate,
   budget is reserved atomically, the child starts, and a visible notice is
   appended.
5. All agents and requests finish, completion evidence is valid, overrides
   expire, and the mission completes.

### Permission and confirmation scenarios

1. A child request violates a system ceiling: no confirmation route exists;
   the request is refused visibly.
2. A child request exceeds an overrideable global/mission field: an exact
   override diff is shown, the mission enters human intervention, and only the
   authenticated owner's matching confirmation activates it.
3. A stale, partial, different-mission, AI-authored, or non-owner confirmation
   is rejected and journaled.
4. An activated override is re-evaluated before spawn and expires on mission
   terminalization.
5. An active override with a live dependent agent cannot be cancelled until the
   dependent work is stopped or terminalized.
6. A tightened global policy revision applies to subsequent uncommitted
   actions; a relaxed revision does not grant more than the sealed contract.
7. A file path outside canonical roots, a write through a read-only root, or an
   uncertain symlink resolution is denied.

### Error and retry scenarios

1. Retryable start/runtime/child-start errors below the automatic threshold
   enter finite retry flow using an injected deadline.
2. A retry at the validation threshold waits for an exact human authorization;
   a chat message cannot authorize it.
3. Non-retryable or exhausted errors reach request/agent failure and signal the
   mission without assigning mission state from the adapter.
4. A stale retry deadline or duplicate attempt key cannot launch twice.
5. A stop failure retries finitely; exhaustion is explicit and prevents the
   mission from claiming process quiescence without reconciliation evidence.

### Cancellation and descendant scenarios

1. Cancelling a draft reaches `cancelled` immediately because no processes or
   requests exist.
2. Cancelling a running mission enters `cancelling`, rejects new work, cancels
   open requests, and stops the agent graph deepest-first.
3. Cancellation racing an in-progress pause upgrades each restartable stop to a
   terminal stop (`A27`) instead of leaving interrupted agents behind.
4. A stop first cancels/reconciles any open launch intent, so absence evidence
   cannot race a delayed process creation.
5. A parent without a live process receives trusted `LOCAL_PROCESS_ABSENT`
   evidence and does not become stuck in `stopping`.
6. An unexpected parent process death enters `failing`, cancels descendants,
   and reaches `failed` only after descendant quiescence.
7. A mission reaches `cancelled`/`failed` only after trusted aggregate and
   local-process quiescence facts and after override expiry.

### Persistence and recovery scenarios

1. Persistence failure before commit causes neither a state change nor a
   process effect.
2. Crash after commit but before process acknowledgement replays the same
   idempotent intent.
3. An acknowledgement from an earlier launch/stop token is rejected.
4. Message, budget, and child creation idempotency keys prevent duplicate
   durable effects.

## Invariant review

- No machine has an outgoing transition from a declared terminal state.
- Every transition references a state and event declared by its own machine.
- The mission cannot launch without a valid immutable snapshot and policy.
- No path creates a child record before deterministic policy approval.
- No accepted child can cross mission or parent lineage.
- No parent stopping path can acknowledge completion before descendant
  quiescence.
- No policy path can bypass immutable system ceilings.
- No mission can report `paused` while an agent or start intent remains live.
- No active override can be removed while live work depends on it.
- No AI-sourced event launches, stops, retries, cancels, confirms, grants, or
  directly changes mission/agent/request/override state.
- No ambient time, random value, filesystem call, process call, or host SDK is
  required by a model guard.
- Thread visibility and technical-detail separation are model rules, not view
  conventions.

## Findings resolved during Review

| Finding | Resolution |
| --- | --- |
| Direct `cancelled`/`failed` could hide asynchronous cleanup | Added mission `cancelling` and `failing` states with quiescence evaluation |
| Direct `active → paused` could expose a stable pause before agents stopped | Added `pausing` and quiescence-gated `M22` |
| A ready/interrupted parent with no process could remain stuck in `stopping` | Added trusted `LOCAL_PROCESS_ABSENT` acknowledgement and `A22`/`A23` |
| Unexpected parent exit could leave live descendants under a terminal parent | Added agent `failing`, terminal descendant cancellation, and `A24` |
| Policy confirmation did not necessarily surface at mission level | Added structured blocker effect and `M21`; resolution is explicit |
| Retry thresholds had no explicit human event | Added agent and subagent retry-authorization events bound to exact evidence |
| Parent could become inactive before initial request policy validation | Added `S13` visible refusal branch |
| A confirmed override could race mission/parent activity before spawn | `S07` rechecks mission, parent, policy, and reservation immediately before child creation |
| Cancelling an active override could strand work outside effective policy | `O07` now requires no live dependency; terminal expiry waits for quiescence |
| Mission cancellation could race a restartable pause and leave agents interrupted | `A27` upgrades an in-flight restartable stop to terminal cancellation |
| Process absence could race an unacknowledged launch | Stop transitions cancel launch intents and `A14` requires none open (`INV-15`) |

No unresolved state-topology gap remains for the M1 scope.

## Business-logic leakage risks for Implement

The future implementation must be rejected if any of these patterns appears:

- SwiftUI/AppKit assigns a status or treats button enablement as authorization.
- An application service chooses a target state instead of submitting an event.
- A process adapter maps exit text directly to mission/agent state.
- Free-form chat is parsed as launch, approval, retry, cancellation, or grant.
- A policy adapter returns an allow/deny decision instead of canonical facts.
- A local agent can reach tools or files without a per-action modeled policy
  decision bound to a global-policy revision.
- Retry counts, budget decisions, or validation thresholds live only in a
  process runner or view model.
- A template or mission snapshot is edited in place after launch.
- Parent cascade order is computed ad hoc by UI/process code.
- Thread visibility is enforced only by presentation filtering.
- Raw logs, secrets, prompts, chain-of-thought, or tool payloads are copied into
  the shared thread.
- A host adapter catalogue or manifest becomes a dependency of the M1 launch
  path.

These boundaries must become architecture and regression contract tests during
Implement/Verify.

## Required future contract tests (not implemented now)

Before implementation can be considered verified, the test plan must include:

1. allowed transition tests for every `M*`, `A*`, `S*`, and `O*` edge;
2. wrong-source, wrong-state, malformed, stale, duplicate, and post-terminal
   rejection tests for every event family;
3. branch exclusivity tests for every table row in Transition review;
4. invariant/property tests for policy ceilings, budget atomics, immutable
   snapshots, lineage, acyclicity, and terminal immutability;
5. descendant-first cancellation tests across multiple depths and partial
   process failures;
6. crash/replay/idempotency tests around launch, stop, message, budget, child,
   and override effects;
7. architecture tests proving pure XState/domain code and absence of business
   rules in UI, adapters, and process actors;
8. AI-boundary tests rejecting target states, commands, approvals, retries,
   cancellations, grants, or impersonated source principals in AI signals;
9. visibility/privacy tests proving M1 direct-message rejection and technical
   detail/secret exclusion from the thread;
10. a fresh local macOS reference scenario that starts agents, handles a
    subagent allow and refusal, pauses/resumes, cancels descendants-first, and
    persists a replayable journal.

## Accepted residual limits

- Concrete built-in team contents, registered local tools, and numeric default
  ceilings are configuration data not decided by the product brief. They must
  be structured, versioned, and validated before a mission can launch; tests
  may use explicit fixtures.
- M1 is single-Mac and local-process scoped. Distributed locks, remote workers,
  cloud identity, and synchronization require a separately modeled change.
- M1 provides shared visibility only. The envelope supports a future direct
  mode but grants it no capability.
- Diagnostic retention duration and macOS sandbox/entitlement choices require
  a later security/implementation review; the current invariant is minimization
  and redaction.
- Existing DFI delegation remains an independent workflow; convergence, if
  desired, requires a future model-first change.

These limits do not create an implicit transition or grant authority in M1.

## Model-only verification record

The checks appropriate to Model/Review passed without invoking repository CI or
implementation tests:

- both JSON files parse, contain no duplicate object keys, and have no trailing
  whitespace;
- the graph satisfies its Draft 2020-12 schema contract;
- all declared state/event/transition references resolve;
- every state and terminal state is structurally reachable from its machine's
  initial state;
- no declared terminal state has an outgoing transition;
- every declared event is used and every branch id is unique;
- the only AI-sourced event surface is `AGENT_SIGNAL_RECORDED` on the mission
  and agent machines;
- the machine totals are 11/14/22 (mission states/events/transitions),
  11/16/27 (agent), 10/10/15 (subagent request), and 7/6/7 (policy override);
- at Model/Review completion, the four planned executable XState paths did not
  exist (they were added only after the subsequent authorization recorded above);
- repository whitespace checks pass for the specification changes;
- the ordered model manifest recomputes to
  `9b6613df9f584ef8bc33cf0a274f539b7e3513fc48e642c9fd825dd03d1a88d6`.
