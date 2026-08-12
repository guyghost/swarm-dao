# Local Agent Mission for macOS — M1 Behavioral Reference

## Status and objective

This document and `local-agent-mission.graph.json` complete **Model** for the
first milestone of a standalone native macOS application that launches,
orchestrates, and observes local agents. `local-agent-mission.review.md`
completes **Review**. No executable state machine, application service, process
adapter, persistence adapter, or UI is part of this change.

The milestone succeeds when a human can start a mission from a team template,
talk with local agents in one mission-wide shared thread, inspect each agent's
technical card, pause or cancel the mission, answer explicit human-input
requests, and observe policy-controlled subagent creation. State transitions
remain deterministic and auditable throughout.

The short rule is binding:

> If the behavior cannot be modelled, it is not ready to be implemented. If a
> state transition depends on an LLM, the architecture is incorrect. The LLM
> produces signals. The model decides.

## Source-of-truth set

The following files form the reviewed behavioral contract:

1. `models/local-agent-mission.md` — semantics and architectural boundary.
2. `models/local-agent-mission.graph.json` — machine-readable states, events,
   transitions, effects, forbidden paths, and invariants.
3. `models/local-agent-mission.graph.schema.json` — structural contract for the
   graph.
4. `models/local-agent-mission.review.md` — coverage review and deferred
   implementation gate.

Where prose and graph differ, the graph is authoritative for transition
topology. A future implementation must use XState v5 and must not add an edge
that is absent from the graph. A behavioral change starts by updating this
source-of-truth set and reviewing a new exact model hash.

The model hash is the SHA-256 of an ordered content manifest. In this exact
order, hash each file, serialize `<digest><two spaces><relative path>\n`, then
SHA-256 the resulting UTF-8 manifest:

```text
models/local-agent-mission.md
models/local-agent-mission.graph.json
models/local-agent-mission.graph.schema.json
```

The review file records but does not contribute to the hash.

## Scope

### Included in M1

- A native macOS application, preferably SwiftUI, integrated into the monorepo
  as a distinct project.
- A local-only runtime launched and owned by the application.
- One shared mission thread containing human messages, agent-facing messages,
  and concise system decision notices.
- An agent detail card containing role, modeled state, effective permissions,
  optional parent, capabilities, and a structured activity journal.
- Built-in team templates, pre-launch adjustment, user-created templates,
  saved revisions, and duplication.
- An immutable mission snapshot of the exact launch team and autonomy contract.
- Structured policy for tools, budgets, delegation, file access, validation
  thresholds, and retries.
- Policy-controlled subagent requests and descendants-first stopping.
- Deterministic cancellation, errors, retries, permissions, and terminal states.

### Explicitly deferred

- Universal host/agent adapters, adapter manifests, adapter catalogues, and a
  configuration assistant.
- Direct messages or private channels. The message envelope carries visibility
  now so the persistence model will not need to change, but M1 rejects
  `direct` with `feature_not_enabled`.
- Remote execution, distributed coordination, and cloud synchronization.
- UI, API, orchestration, storage, process code, executable XState machines,
  implementation tests, and production verification.

The application may reuse pure domain concepts from Swarm DAO later, but M1 is
not organized around the existing host-adapter catalogue. It launches local
agent processes itself.

## Relationship to existing Swarm DAO models

This workflow has no authority over proposal, Graph Engineering, Improvement
Loop, Product Loop, or Delegated Facet Investigation state. Correlation values
do not grant permission and do not cause cross-machine transitions.

`packages/core/src/governance/delegation.machine.ts` currently models delegated
facet investigation inside DAO deliberation. The macOS mission model does not
reuse that lifecycle as its authority: a desktop mission has different
ownership, policy overrides, process lifetime, thread visibility, and arbitrary
parent depth. The future implementation may reuse pure helpers only when their
contracts remain compatible with this model.

## Architectural boundary

The future design follows the repository's functional-core direction:

```text
SwiftUI/AppKit host
  -> application commands
    -> pure XState models and policy functions
      -> next snapshots + structured results + effect intents
    -> local persistence and process ports
  -> presenters read snapshots and results
```

Only four future XState machines own business state:

| Authority | Aggregate | Planned executable model (Implement only) |
| --- | --- | --- |
| `mission-machine` | One mission | `localMissionMachine` |
| `agent-machine` | One local agent | `localAgentMachine` |
| `subagent-request-machine` | One request | `subagentRequestMachine` |
| `policy-override-machine` | One mission override | `policyOverrideMachine` |

Any model-provider/LLM call lives in a dedicated AI worker behind a typed
signal port. SwiftUI views, application command handlers, policy functions,
process actors, and persistence adapters do not call an LLM inline.

The models are pure. They do not import filesystem, process, network, clock,
randomness, macOS frameworks, or host SDKs. Time, canonical paths, process
identities, and durable evidence enter as typed event data. I/O adapters execute
committed effect intents and return acknowledgements as new events.

UI controls may reflect whether an event appears available, but UI enablement
is never authorization. The model revalidates every submitted event.

## Identity, ordering, and event envelope

Every event must contain:

- `eventId`: globally unique id generated outside the model;
- `missionId` and the target aggregate id;
- `type` and `source` (`human`, `ai`, `system`, or `tool`);
- a source principal id and an authenticated source role;
- an injected occurrence time;
- an aggregate revision expected by the sender;
- an idempotency key for any effect-producing operation;
- a payload matching the event type.

Stale aggregate revisions, duplicate idempotency keys, malformed payloads,
wrong-source events, and unknown event types are rejected and journaled. Source
is not trusted merely because a payload says `source: "human"`; the application
boundary authenticates the principal and the model checks its mission role.

An AI worker can emit only these signal families:

- human-facing shared message content;
- structured `human_input_required` with a question/request id;
- structured `subagent_requested` with role, capabilities, resource request,
  and parent correlation;
- structured completion evidence or progress content that remains a signal.

AI signals cannot contain a target state, shell command, tool id selected for
execution, approval, retry authorization, cancellation, permission grant,
policy verdict, next event, or impersonated human source.

## Team templates and immutable mission snapshots

### Template aggregate

A team template is an append-only sequence of immutable revisions. Each
revision contains stable template identity, revision number, origin
(`built_in`, `user`, or `duplicate`), lineage, display metadata, and normalized
top-level agent definitions. An agent definition contains role, capabilities,
default resource request, and launch configuration identifiers; it contains no
runtime state.

The command rules are:

| Command | Rule | Result |
| --- | --- | --- |
| `CREATE_TEMPLATE` | Authenticated human, valid normalized team | New user template revision 1 |
| `SAVE_TEMPLATE_REVISION` | User-owned template; optimistic revision matches | New immutable revision under the same template id |
| `DUPLICATE_TEMPLATE` | Readable source revision | New template id, revision 1, and immutable lineage |

Built-in revisions cannot be overwritten. Editing a built-in template inside a
mission draft changes only that draft unless the human explicitly saves it as a
new user template. Saving or duplicating never changes an existing mission.

### Mission draft and seal

While the mission is `draft`, the owner may select a template revision, adjust
the team, and edit the structured autonomy contract. `MISSION_LAUNCH_REQUESTED`
is accepted only when:

1. every top-level agent definition is valid and has a unique id;
2. the team contains at least one enabled top-level agent;
3. the autonomy contract contains every required policy dimension;
4. the contract is within effective policy;
5. every referenced override is active and bound to this mission;
6. no requested override awaits confirmation;
7. the canonical snapshot and content hash can be produced.

The accepted launch seals one immutable `mission-template-snapshot` containing
the fully normalized adjusted team, source lineage, base autonomy contract, and
content hash. Runtime changes are expressed as append-only policy overrides or
new agent/subagent aggregates, never by mutating the launch snapshot.

## Structured autonomy and policy hierarchy

The base autonomy contract has six mandatory dimensions:

| Dimension | Minimum structured content |
| --- | --- |
| `allowedToolIds` | Stable registered tool ids; never shell command text |
| `budgetLimits` | Currency/token/time/action envelopes and reservation rules |
| `delegationLimits` | Enabled flag, maximum depth, per-parent children, mission concurrency |
| `fileAccessRules` | Separate canonical read roots and write roots; explicit deny entries |
| `validationThresholds` | Risk/action classes requiring human confirmation |
| `retryLimits` | Finite start, runtime, subagent-start, and stop retry limits |

Missing data fails closed. The model does not infer policy from prose.

### Three policy levels and the sealed contract

The required product policy has three administrative levels:

1. **System ceilings** — installed immutable hard limits. They cannot be
   changed by application settings or mission events.
2. **Application-global rules** — application defaults changed by publishing a
   new immutable revision. Each field declares whether a mission may override
   it.
3. **Mission-specific overrides** — exact structured diffs confirmed by the
   mission owner, journaled, scoped to one mission/request, and removed at the
   mission's terminal transition.

The sealed mission autonomy contract is the mission's immutable base request
inside those levels. An override may temporarily relax an eligible global or
mission-contract field, but never a system ceiling or a field marked
non-overrideable. It does not rewrite the snapshot.

Evaluation is deterministic:

1. Validate complete canonical request facts.
2. Reject any system-ceiling violation.
3. Apply global rules.
4. Apply the sealed mission contract.
5. Apply only active overrides whose mission, request, policy fields, values,
   and fingerprint match exactly.
6. Recheck the system ceilings.
7. Atomically reserve the required budget.
8. Return `allow`, `requires_human_confirmation`, or `deny` with stable reason
   codes.

Application-global rules are immutable revisions once published. Every policy
decision and effect intent records the revision evaluated. A tighter new
revision applies to the next uncommitted action; it does not rewrite journaled
history. A looser revision never widens a sealed mission contract implicitly.
All tool/file operations are mediated per action, so a long-running local agent
does not retain an unmodelled standing grant after policy changes.

For sets, the default operation is intersection. An active eligible override
may expand an overrideable lower-layer set while remaining inside the system
allowlist. Numeric maxima remain at or below the system ceiling. Approval
thresholds fail toward more human confirmation. File access is checked only on
canonical paths supplied with trusted resolution evidence; uncertainty,
symlink escape, or a mismatch between read/write capability fails closed.

### Policy override lifecycle

The `policy-override-machine` uses:

```text
proposed -> ceiling_check -> awaiting_confirmation -> active
                         \-> rejected
active -> expired | cancelled
```

`POLICY_OVERRIDE_CONFIRMED` must come from the authenticated mission owner and
must repeat the exact structured-diff fingerprint shown for confirmation. A
stale or partial confirmation is rejected. Rejection/refusal is visible in the
shared thread when the override was required by an agent request. Every active
override receives `POLICY_OVERRIDE_EXPIRED` as part of mission terminalization.
An active override cannot be removed while a live agent or request depends on
it. The owner must first stop/cancel the dependent work; terminalization expires
overrides only after dependent aggregates and processes are quiescent.

## Shared thread and agent detail boundary

### Shared mission thread

Messages are append-only. Corrections are new messages; M1 has no edit that
rewrites history. The shared thread contains:

- human-authored mission messages;
- agent-authored human-facing messages after structural validation and secret
  redaction;
- concise system notices for mission state, human validation, subagent started,
  subagent refused/failed, and override decisions.

Every message has a visibility envelope:

```text
visibility.kind = mission_shared | direct
visibility.participantIds = [] for mission_shared
```

M1 accepts only `mission_shared`. The `direct` shape is reserved now so future
private discussions can use the same message aggregate and storage envelope;
the M1 capability gate rejects it rather than silently widening visibility.

### Technical agent card

The agent card reads `agent-record`, effective-policy projections, and its
append-only activity journal. It exposes:

- role and modeled lifecycle state;
- effective permissions and the policy/override ids that produced them;
- parent agent when present and descendant count;
- declared capabilities;
- structured activity such as launch, stop, retry, tool-intent category,
  budget charge, and error reason code.

Raw prompts, chain-of-thought, secrets, full environment values, raw stdout or
stderr, unredacted tool inputs/outputs, and tokens are not persisted for this
view. A bounded, redacted diagnostic excerpt may be linked as local evidence if
future security policy explicitly permits it; it never becomes a thread
message automatically.

## Mission lifecycle

The graph declares these states:

```text
draft -> pending -> active -> completed
                   |  |  \
                   |  |   -> human_intervention_required -> active | pending
                   |  -> pausing -> paused -> pending
                   -> cancelling -> cancelled
any running state -> failing -> failed
```

`pausing`, `cancelling`, and `failing` are explicit control/cleanup states added
to the product vocabulary so asynchronous process shutdown cannot be hidden
inside a direct stable or terminal transition. `completed`, `cancelled`, and
`failed` are terminal.

Identifiers follow the repository's English conventions. A localized macOS
presenter may render `pending` as « en attente », `human_intervention_required`
as « intervention humaine requise », `completed` as « terminée », and `failed`
as « erreur »; labels never change model identity or authority.

### Mission state meanings

| State | Meaning |
| --- | --- |
| `draft` | Team and autonomy contract may be edited; no agent process exists |
| `pending` | Snapshot is sealed and required agents are starting/restarting |
| `active` | Required top-level agents are active and the mission accepts agent work |
| `pausing` | Restartable descendant interruption is in progress; no new work is authorized |
| `paused` | All live agents are restartably quiescent and no start intent remains open |
| `human_intervention_required` | One or more explicit blockers await human action |
| `cancelling` | Terminal descendant and request cancellation is in progress |
| `failing` | Fatal cleanup is in progress |
| `completed` | Deterministic completion criteria passed |
| `cancelled` | Owner cancellation completed and the runtime is quiescent |
| `failed` | Fatal outcome recorded and the runtime is quiescent |

The exact transitions are `M01`–`M22` in the graph. Transitions sharing the
same state/event pair are ordered guards and must be mutually exclusive. An
implementation must test that exactly one branch matches.

Mission completion is not an LLM decision. Agents may submit structured
completion evidence, but `MISSION_COMPLETION_EVALUATED` reaches `completed`
only when deterministic criteria prove: all required agents are terminal,
there are no active descendants, no open subagent requests, no unresolved
human blocker, required mission outputs exist, and no committed effect remains
unacknowledged.

## Agent lifecycle

The requested product states are preserved and three explicit control states are
added for testable retry/stop behavior:

```text
ready -> starting -> active -> completed
            |          |  \
            |          |   -> waiting_for_human -> active
            |          -> retry_wait -> starting
            -> retry_wait

ready | starting | active | waiting_for_human | retry_wait | interrupted
  -> stopping -> interrupted | cancelled | failed

interrupted -> starting
unexpected terminal process exit -> failing -> failed
```

`completed`, `cancelled`, and `failed` are terminal (`failed` is the modeled
counterpart of the product label « erreur »). `interrupted` is a
non-terminal, quiescent state used for a restartable pause or explicit agent
stop. Mission cancellation uses the terminal `cancelled` state, not
`interrupted`.

The process adapter never assigns agent state. It returns facts such as a
matching launch token, local process identity, exit classification, or stop
acknowledgement. The model checks these facts and selects `A01`–`A27`.
Unexpected successful exits without completion evidence are not completion;
they follow the retry/error rules.

An agent may enter `waiting_for_human` from a valid structured signal. The
model owns that mapping; the signal cannot name the target. A human response
must match the open request id and the responder's mission permission before
the model returns the agent to `active`.

## Subagent lifecycle and lineage

An active agent may emit a structured `subagent_requested` signal. It contains
requested role/capabilities/resources but no permission verdict and no launch
command. The mission model validates the parent snapshot and creates one
`subagent-request-machine` aggregate:

```text
requested -> policy_validating -> approved -> starting -> started
                  |                 |           |
                  |                 |           -> retry_wait -> approved
                  |                 -> cancelled
                  -> awaiting_policy_override -> policy_validating | refused
                  -> refused
                  -> failed | cancelled
```

The mandatory product path is therefore explicit:

```text
active parent
  -> structured request
  -> deterministic policy validation
  -> child started OR visible refusal/failure
```

`started`, `refused`, `cancelled`, and `failed` are terminal request outcomes.
The child then has its own independent `agent-machine` lifecycle.

A child record is created only from `approved`. Its `missionId` and
`parentAgentId` are immutable, the parent must still be active, the effective
policy must still allow the exact request, and the atomic reservation must
still be held. Policy is rechecked after a confirmed override and immediately
before child start to close time-of-check/time-of-use gaps.

### Descendants-first stop invariant

The persisted agent graph must be acyclic. On parent interruption or
cancellation, a pure function computes a stable descendants-first stop plan
ordered by depth descending and then stable agent id. Each child receives its
own modeled stop event. The parent cannot accept `DESCENDANTS_QUIESCENT` until
every descendant is `completed`, `cancelled`, `failed`, or `interrupted` as
appropriate to the stop reason. New child requests are rejected as soon as a
parent or mission enters a stopping path.

Mission cancellation additionally cancels every non-terminal request and
linked pending override. A process-stop failure is retried within finite policy
limits; exhausted cleanup failure is explicit and prevents false quiescence.

## Retry and error semantics

Retryability comes from a deterministic error-code registry, never arbitrary
error text. The contract has separate finite limits for agent start, agent
runtime, subagent start, and stop. The effective maximum is constrained by the
system ceiling and mission contract.

For every retry:

1. the current error code is classified;
2. model guards verify the relevant retry budget and validation threshold;
3. the attempt number is incremented before scheduling;
4. a deadline is calculated outside the model and later supplied by a system
   event;
5. the next effect uses `missionId:aggregateId:operation:attempt` as its
   idempotency key;
6. evidence remains append-only.

Automatic retry is allowed only below the configured human-validation
threshold. A retry beyond it, if still inside hard limits, requires
`AGENT_RETRY_AUTHORIZED` or `SUBAGENT_RETRY_AUTHORIZED`, bound to the aggregate,
operation, attempt, owner, and error evidence. A chat reply cannot become retry
authorization. Non-retryable and exhausted errors reach explicit `failed` or
mission intervention/failure paths.

## Cancellation and terminalization

Cancellation is owner-only except for system cascade events that are causally
linked to an already accepted owner mission cancellation. It is accepted from
all meaningful non-terminal mission states.

Terminalization order is fixed:

1. stop accepting new agent work and subagent requests;
2. cancel non-terminal subagent requests and pending linked overrides;
3. stop agents descendants-first;
4. prove all aggregates and local processes are quiescent;
5. release or finalize resource reservations;
6. expire active mission overrides;
7. append the terminal snapshot and system notice;
8. enter `cancelled` or `failed`.

`completed` uses the same override-expiry and evidence-finalization rules but
requires all work to be already terminal. Every terminal state rejects all
later events and journals the rejection without changing its snapshot.

## Effect protocol and crash recovery

The local app must use a transactional outbox or equivalent single-commit
protocol:

```text
event + current snapshots
  -> pure model decision
  -> next snapshots + journal entry + effect intents
  -> atomic durable commit
  -> idempotent local effect execution
  -> typed acknowledgement event
```

No process is launched, stopped, messaged, or charged before its intent is
durable. If persistence fails, neither the transition nor effects commit. If
the app crashes after the commit, recovery replays the intent using its stable
idempotency key and reconciles local process identity/launch tokens. An
acknowledgement with a stale token is rejected rather than attached to a newer
attempt.

## Explicit rejection policy

The absence of a declared transition is a rejection, not an ignored event.
Every rejection records the event type, authenticated source, aggregate state,
stable reason code, and redacted evidence. At minimum, the implementation must
distinguish:

- `wrong_source`;
- `wrong_state`;
- `malformed_payload`;
- `stale_revision`;
- `duplicate_idempotency_key`;
- `permission_denied`;
- `policy_denied`;
- `system_ceiling_exceeded`;
- `human_confirmation_required`;
- `stale_confirmation_fingerprint`;
- `feature_not_enabled`;
- `terminal_state_immutable`;
- `cross_mission_reference`;
- `parent_not_active`;
- `descendants_not_quiescent`.

Free-form error messages may accompany a stable reason code for diagnostics,
but guards use only structured fields and registered codes.

## Planned XState implementation constraints (deferred)

The future Implement phase must use XState v5 `setup()` with discriminated
event unions and explicit context/input types. Pure named guards select the
edges in the graph; immutable `assign()` actions produce model data and effect
intents. Filesystem/process actors and macOS services live outside the models.

The four machines should remain separate so one request/agent cannot overwrite
mission state, while the application layer dispatches model-authorized
cross-machine events. Shared pure functions should own policy merge, canonical
request validation, retry classification, descendant planning, completion
evaluation, and redaction classification.

Implementation may begin only after explicit human approval of the exact
reviewed model hash. That approval is not included in this Model/Review task.
