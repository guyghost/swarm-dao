# Swarm DAO Graph Engineering Pilot

## Objective

Adopt the standalone Graph Engineering pilot as a repository-local change-control
overlay for Codex work in Swarm DAO. The overlay must make model approval,
implementation authorization, verification, retries, and terminal outcomes
deterministic without creating a second authority for the existing proposal
lifecycle.

The pilot succeeds when a repository change can move from an explicit reviewed
model to a verified implementation through an XState machine, typed signals,
an exact human-approved model hash, frozen runtime anchors, and durable evidence.

## Architectural boundary

1. `packages/core/src/models/proposal.machine.ts` remains the only authority for
   Swarm DAO proposal states (`open`, `deliberating`, `approved`, `controlled`,
   `executed`, `failed`, `rejected`).
2. The Graph Engineering machine owns only the state of a Codex change run. It
   never emits proposal events and never writes `.dao/`.
3. A run may carry an immutable `proposalId` correlation value, but that value
   grants no permission and causes no transition in either machine.
4. The pilot stores local evidence under `evidence/graph-runs/`. Generated
   evidence is not committed.
5. The executable machine will live in `packages/core/src/models` so it obeys
   the existing functional-core boundary. Filesystem persistence, command
   execution, and hooks live outside the core model.

## Roles and graph

| Node | Kind | Authority | Responsibility |
| --- | --- | --- | --- |
| `modeler` | AI worker | signal only | Draft states, events, effects, invariants, and repository anchors |
| `model-contract-validator` | deterministic tool | anchor | Validate the graph contract and compute its SHA-256 model hash |
| `implementer` | AI worker | signal only | Produce an implementation bound to the approved model hash |
| `runtime-verifier` | deterministic tool | anchor | Run frozen graph tests, repository CI, and the reference scenario |
| `architecture-watcher` | deterministic tool | veto | Prove the hexagonal dependency rules still hold |
| `regression-watcher` | deterministic tool | veto | Prove forbidden transitions and AI authority escalation remain impossible |

The human owner is outside the worker graph. Only the owner approves a precise
model hash, rejects a model, authorizes a retry, or cancels a run. All nodes and
edges are declared in `models/graph-engineering.graph.json`; prose cannot invent
an edge.

## Workflow model

### States

```text
draft
  -> modelReview
  -> awaitingApproval
  -> ready
  -> implementing
  -> verifying
  -> succeeded | retrying | failed | blocked | cancelled
```

`succeeded`, `failed`, `blocked`, and `cancelled` are terminal.

### Events and permitted sources

| Event | Source | From | To / effect |
| --- | --- | --- | --- |
| `MODEL_DRAFTED` | `ai` | `draft` | `modelReview`; record the computed model hash |
| `MODEL_CONTRACT_VALID` | `tool` | `modelReview` | `awaitingApproval`; record contract evidence |
| `MODEL_CONTRACT_INVALID` | `tool` | `modelReview` | `failed`; record the issues |
| `MODEL_APPROVED` | `human` | `awaitingApproval` | `ready` only when the supplied hash exactly matches |
| `MODEL_REJECTED` | `human` | `awaitingApproval` | `draft`; clear model approval and attempt evidence |
| `START_IMPLEMENTATION` | `system` | `ready` | `implementing` |
| `IMPLEMENTATION_READY` | `ai` | `implementing` | `verifying`; record the implementation hash |
| `IMPLEMENTATION_FAILED` | `ai` | `implementing` | `retrying` when retries remain, otherwise `failed` |
| `ANCHOR_RECORDED` | `tool` | `verifying` | Record one immutable result for the current attempt |
| `EVALUATE` | `system` | `verifying` | `succeeded`, `retrying`, or `failed` according to anchors and retry budget |
| `RETRY_AUTHORIZED` | `human` | `retrying` | `implementing`; increment attempt and clear attempt-scoped evidence |
| `PERMISSION_DENIED` | `tool` | any active state | `blocked` |
| `CANCEL` | `human` | any active state | `cancelled` |

Events from the wrong source or state are rejected and journaled. Free-form
text is never converted into a human event.

### Required success anchors

Every anchor must be present, `passed`, non-empty, and bound to the current
implementation attempt. The model contract anchor is bound to the reviewed
model hash and survives an authorized implementation retry.

1. `model-contract` — graph topology, schema, executable constants, and model
   hash agree.
2. `graph-tests` — allowed and forbidden graph transitions, signal validation,
   journaling, and deterministic replay pass.
3. `architecture-contract` — existing core purity and dependency-direction
   contracts pass with the new model.
4. `repository-ci` — the repository's canonical `bun run ci` gate passes.
5. `runtime-scenario` — a fresh end-to-end graph run reaches `succeeded` and
   persists a complete journal and snapshot.
6. `regression` — the independent counter-metric proves that wrong-source,
   stale-hash, duplicate-anchor, post-terminal, and LLM transition attempts
   remain rejected.

The frozen commands are declared in `models/graph-engineering.graph.json` and
executed only by the tool adapter. An AI signal cannot provide or replace a
command.

## Side effects

- Append every accepted and rejected signal to an NDJSON journal.
- Persist the current XState snapshot after every submitted signal.
- Compute model and implementation hashes outside AI workers.
- Keep all core model actions pure; timestamps are injected by the evidence
  adapter and are not transition guards.
- On retry, retain the approved model hash and `model-contract` evidence but
  clear the implementation hash and all attempt-scoped anchors.
- A project-local Codex Stop hook may block a normal stop while an active run
  is non-terminal. The hook reads the snapshot; it does not decide state.

## Invariants

1. Only an XState machine changes Graph Engineering run state.
2. Graph signals cannot contain `nextState`, `targetState`, `transition`, shell
   commands, approval, retry authorization, cancellation, or permission grants.
3. `MODEL_APPROVED.modelHash` must exactly match the reviewed model hash.
4. Implementation cannot start before contract validation and explicit human
   approval.
5. The model hash is the SHA-256 of the ordered content manifest for
   `models/graph-engineering.md` and `models/graph-engineering.graph.json`.
6. An implementation hash is mandatory before verification.
7. A run cannot succeed without all six required anchors.
8. The implementer cannot produce, replace, or waive anchor evidence.
9. A failed anchor cannot be overwritten in the same attempt.
10. Evidence from one implementation attempt cannot satisfy a later attempt.
11. Retries are bounded to two and always require a human event.
12. Permission denial and cancellation are explicit terminal outcomes.
13. Terminal states reject every later event.
14. Graph Engineering status never changes a Swarm DAO proposal status, and a
    proposal status never implicitly changes a Graph Engineering run.
15. Existing core-model purity rules apply: no filesystem, network, ambient
    clock, randomness, host SDK, or async orchestration in the machine.

## Model hash procedure

From the repository root, the validator computes individual SHA-256 digests in
this exact order, serializes each as `<digest><two spaces><relative path>\n`,
then hashes the resulting UTF-8 manifest with SHA-256:

```text
models/graph-engineering.md
models/graph-engineering.graph.json
```

The review file is not part of the model hash. Changing either model file
invalidates any earlier approval.

## Planned implementation surface after approval

- `packages/core/src/models/graph-engineering.machine.ts` and public model export.
- Repository-local graph signal validation, evidence journal, deterministic
  replay, validator, CLI, and successful reference scenario under
  `tools/graph-engineering/`.
- Contract, integration, architecture, and regression tests.
- `.agents/skills/graph-engineering/` instructions and a project-local Codex
  Stop hook that consumes the persisted snapshot.
- Root scripts for `graph:init`, `graph:status`, `graph:submit`,
  `graph:validate`, `graph:demo`, and `graph:regression`.
- `.gitignore` coverage for generated graph evidence.

No implementation file may be added or changed before the owner approves the
exact model hash.

