# Local Agent Workspace Persistence and Recovery — M2 Behavioral Reference

## Status and authority

This document and `local-agent-workspace-persistence.graph.json` define the
**Model** for the native macOS Agent Workspace local-persistence milestone.
`local-agent-workspace-persistence.review.md` records **Review**. They extend,
but do not replace, `local-agent-mission.*`: its graph remains authoritative
for ordinary transitions, and the M2 graph is authoritative for durability and
the only additional restart-recovery edges.

> A storage adapter reports typed facts; it does not choose mission or agent
> state. AI never participates in loading, migration, recovery, or persistence.

## Scope and persisted record

M2 persists one local workspace containing:

- the mission XState persisted snapshot, including its immutable launch
  template/autonomy snapshot and append-only shared messages;
- every agent XState persisted snapshot, lineage, effective permissions, retry
  counters, and sanitized technical activity;
- append-only revisions of user-created and duplicated team templates;
- the last human-submitted structured autonomy configuration;
- message/idempotency sequences and recovery audit entries.

Built-in templates remain code-owned immutable revisions and are merged with
persisted user revisions for projection. A launched mission does not depend on
the current built-in revision because its sealed snapshot is persisted.

Still deferred: multiple concurrently selected mission workspaces, private
conversations, generic adapters/catalogues/manifests, a configuration
assistant, real LLM integration, remote execution, and cloud sync.

## Persistence boundary and atomicity

The persistence/recovery machine owns durability state only. Existing mission
and agent XState machines continue to own business state. No external process
or file effect executes until the complete proposed workspace is durable.

```text
durable workspace + typed command
  -> business model proposes snapshots and effect intents
  -> persistence model accepts PERSISTENCE_SAVE_REQUESTED
  -> file port validates, writes, fsyncs, and atomically renames one envelope
  -> persistence model accepts STORAGE_SAVE_COMMITTED
  -> committed non-storage effects may execute
```

On write failure, the service restores the last durable snapshots before
returning an error, and no effect from the rejected record runs. Retries carry
the identical pending payload hash. An already-current payload hash is
acknowledged without rewriting or incrementing the durable revision.

The adapter uses a private application-support directory, one versioned JSON
file, a same-directory temporary file, restrictive permissions, file `fsync`,
atomic rename, then directory `fsync`. A stale/partial temporary file is never
promoted; the committed file is the only authority.

## Storage envelope, validation, and migrations

Schema version `1` requires `schemaVersion`, positive monotonic `revision`, an
injected `savedAt`, SHA-256 `payloadHash`, the complete `payload`, and a SHA-256
`checksum` over the envelope excluding `checksum`.

The loader rejects unknown fields, malformed snapshots, duplicate template
identity/revision pairs, cross-mission agents, invalid autonomy contracts,
unredacted prohibited activity, or hash/checksum mismatch before actor
restoration. Version `0` is the only legacy input in M2: its exact complete
payload is validated, upgraded, and atomically committed as v1 before recovery.
A higher version enters `incompatible`; malformed or unsupported older data
enters `corrupt`. Neither condition overwrites the source file.

## Explicit restart recovery semantics

Startup never reconnects to or recreates a pre-restart child process. The new
process registry starts empty and supplies trusted absence facts to the model.
Pre-restart process ids, tokens, and process effect intents are cleared.

Recovery is descendants-first:

1. Restore validated XState persisted snapshots without executing effects.
2. For `pending`, `active`, `pausing`, or `human_intervention_required`, send
   `WORKSPACE_RESTART_RECOVERED` to each non-terminal agent with
   `restartable_interruption`; each becomes `interrupted`.
3. Send the event to the mission; it becomes `paused`, records its prior state
   and recovery time, and appends one shared system notice.
4. Only the authenticated owner’s existing `MISSION_RESUME_REQUESTED` edge may
   create and commit fresh launch intents.
5. A persisted `cancelling` mission recovers non-terminal agents and itself to
   `cancelled` after absence/quiescence facts. `failing` similarly reaches
   `failed`. Neither can return to active work.
6. `draft`, `paused`, and terminal snapshots do not widen their available
   commands. Paused recovery remains paused; terminal states remain immutable.

This deliberately narrows M1’s general outbox replay rule: local process
start, send, retry, and stop intents from a previous app process are never
replayed automatically. Only a new model-authorized human resume may create
new process intents.

## Templates and autonomy configuration

Templates use the already modeled human commands `CREATE_TEMPLATE`,
`SAVE_TEMPLATE_REVISION`, and `DUPLICATE_TEMPLATE`. Revisions are immutable and
append-only. A duplicate has a new external id, revision 1, and exact lineage;
built-ins cannot be overwritten. Later saves cannot mutate mission snapshots.

The last autonomy configuration is a structured convenience default, not an
authorization. Launch revalidates it through mission/policy models. Restoration
cannot launch, resume, approve, or grant anything.

## Failure, retry, and terminal behavior

- Transient saves retain one immutable pending payload and retry only to a
  finite limit using injected typed events. Human retry must match hash/attempt.
- Exhaustion enters `storage_blocked`; invalid load enters `corrupt`; a future
  version enters `incompatible`. These states are terminal for this host and
  expose no mutating command.
- Closing the app is not mission cancellation. It stops owned processes; the
  next startup applies modeled interruption recovery.
- Destructive reset/repair UI is deferred; M2 preserves bad files for diagnosis.

## Executable-model constraints

`localWorkspacePersistenceMachine` uses XState v5 `setup()`, discriminated
events, pure guards, and immutable `assign()`. Filesystem, clock, hashing, and
process inspection remain ports. SwiftUI consumes `storageStatus`, recovery,
templates, policy configuration, and model-derived commands; it never assigns
lifecycle state or treats enablement as authorization.
