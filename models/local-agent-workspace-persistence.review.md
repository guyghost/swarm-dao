# Local Agent Workspace Persistence and Recovery — M2 Review

## Result

**Approved for Implement in the authorized M2 scope.** Reviewed source set:

1. `models/local-agent-workspace-persistence.md`
2. `models/local-agent-workspace-persistence.graph.json`
3. `models/local-agent-workspace-persistence.graph.schema.json`

Ordered-manifest SHA-256 after structural validation:
`d0500713b6b35e55ec781a703fd7cc95406940acec1ea5e94f1f1ba6ab8388ee`.

## Coverage matrix

| Area | Reviewed behavior | Result |
| --- | --- | --- |
| Load/save | Missing/valid v1, complete private atomic envelope | Covered |
| Active restart | Agents interrupted, operational mission paused | Covered |
| Human authorization | Only owner resume creates fresh launch intents | Covered |
| History/templates | Shared messages and append-only user revisions restore | Covered |
| Autonomy/policy | Structured defaults and immutable launch contract restore without grants | Covered |
| Corrupt/partial | Exact validation and hashes fail closed; source preserved | Covered |
| Versioning | Exact v0 migration; future versions incompatible | Covered |
| Idempotency | Duplicate payload does not rewrite or increment revision | Covered |
| Save failure/retry | Durable rollback, same hash, finite typed retries | Covered |
| Cancellation/failure | Recovery preserves terminal direction | Covered |
| Terminal behavior | Business terminals immutable; blocked storage cannot mutate | Covered |
| AI authority | No AI persistence/recovery event; no text-driven edge | Covered |

## Scenario review

### Nominal

1. Draft templates/autonomy defaults save and restore without a process.
2. A launched mission restores its sealed snapshot and shared history exactly.
3. Active restart records one notice, interrupts agents, and exposes modeled
   `resume` from `paused`.
4. Repeated recovery is idempotent for notices/activity.
5. Owner resume creates new tokens; stale pre-restart acknowledgements fail.

### Corruption and migration

1. Truncated JSON, bad hashes, malformed snapshots, duplicate template
   revisions, cross-mission agents, or prohibited activity enter `corrupt`.
2. A stale temporary file is ignored and never promoted.
3. Exact v0 migrates once to committed v1 before recovery; migration failure
   preserves the source and blocks mutation.
4. Version 2+ enters `incompatible` without downgrade or overwrite.

### Duplicate, retry, cancellation, failure

1. Changed payload increments revision once; duplicate payload retains revision
   and bytes.
2. Failure before rename leaves the prior committed file authoritative.
3. Retry must carry the same hash and exact finite attempt. Wrong hash/attempt,
   AI source, or exhaustion is rejected.
4. Restart from `cancelling` reaches `cancelled`; restart from `failing` reaches
   `failed`; neither offers resume.
5. Completed/cancelled/failed aggregates reject recovery mutation.

## Transition and invariant audit

- Every transition references a declared state/event; no storage terminal has
  an outgoing transition.
- `P03`/`P04` require exact shape; `P05`/`P06` cannot write.
- `P10` and `P11` are mutually exclusive by payload hash.
- `P12` requires pending-hash identity and monotonic revision.
- `RM01`/`RM02` cannot yield active/starting.
- `RM03`–`RM06` preserve cancellation/failure direction.
- Paused recovery exposes only the existing owner-authorized resume edge.
- No guard consumes messages, prompts, stdout/stderr, or LLM output.

## Leakage risks checked for Implement

Reject implementation if SwiftUI selects recovery state; a loader rewrites
business state without modeled events; a process starts during load/recovery;
invalid storage falls back silently; templates mutate in place; an effect runs
before durable commit; restored autonomy becomes permission; technical activity
enters the thread; or adapters/manifests/private threads/LLMs enter this slice.

No unresolved M2 topology gap remains. Implement may proceed against this
reviewed source set.
