# Review: Swarm DAO Graph Engineering Pilot

## Decision

This revision replaces human `RETRY_AUTHORIZED` with system-owned auto-evaluation
retries. The owner approved the change in conversation; the exact model hash is
`a2a11c62a37e4e0536be59b9e6675a314583d8b57e0f8fd1de37b157ed5ae30c`
(`models/graph-engineering.md` + `models/graph-engineering.graph.json`).
Model-hash approval and cancel remain human. Improvement-loop retries are
unchanged.

## Coverage

| Concern | Model coverage | Decision |
| --- | --- | --- |
| Nominal path | Draft, deterministic contract validation, hash approval, implementation, six anchors, evaluation | Covered |
| Existing proposal lifecycle | Separate authority; immutable optional correlation only | Covered |
| Invalid input | Schema and source guards reject and journal it | Covered |
| Model rejection | Human rejection returns to `draft` and clears approval evidence | Covered |
| Stale approval | Approval hash must equal the current reviewed model hash | Covered |
| Errors | Invalid model and exhausted attempts end in `failed` | Covered |
| Cancellation | Human `CANCEL` is accepted from every active state | Covered |
| Retries | Auto-evaluation, maximum two, attempt-scoped evidence; no human retry event | Covered |
| Permissions | Tool-reported denial ends explicitly in `blocked` | Covered |
| Terminal behavior | Four explicit terminal states reject all later events | Covered |
| Counter-metrics | Architecture and regression watchers are independent mandatory vetoes | Covered |
| Evidence decay | Every anchor requires durable, non-empty, attempt-bound evidence | Covered |
| LLM boundary | AI emits artifacts and failure signals only; no state or command authority | Covered |
| Hexagonal boundary | Machine remains pure; I/O and hooks remain outside core | Covered |

## Transition review

1. No transition is driven by free-form text.
2. Human events are structured, and model approval is bound to an exact
   SHA-256 hash.
3. AI events cannot name a target state, provide commands, approve work,
   cancel, or grant permissions. They cannot authorize or skip a retry.
4. Tool events validate contracts or record independently executed anchors.
5. System events start already-authorized work or evaluate existing evidence;
   they do not manufacture evidence. Failed evaluation with remaining budget
   auto-retries implementation; the hop is not a human authorization.
6. Wrong-source, wrong-state, malformed, duplicate-anchor, and post-terminal
   events are rejected and retained in the journal.

## Invariant review

- There is no path from `draft` to `implementing` that bypasses contract
  validation and exact-hash human approval.
- Graph state cannot mutate proposal state; proposal state cannot authorize a
  Graph transition.
- `EVALUATE` has no success path when an anchor is missing, failed, empty, or
  belongs to another attempt.
- A failed anchor is immutable for the current attempt.
- A retry keeps the approved model but clears implementation evidence. It is
  selected by `EVALUATE` / `IMPLEMENTATION_FAILED` against the retry budget,
  never by a human or AI retry event.
- The architecture and regression vetoes cannot be replaced by the implementer.
- Permission denial cannot silently become a retry.
- Core-model purity is protected by the existing architecture contract tests.

## Implementation review

The planned implementation reuses the repository's XState dependency and
existing `packages/core/src/models` source-of-truth convention. It adds a
repository-local tool adapter rather than extending `.dao/state.json`, so the
pilot does not introduce a storage migration or a second proposal workflow.

The root `bun run ci` command remains the canonical repository gate. Targeted
graph tests, architecture tests, a real graph scenario, and a focused
regression counter-metric provide narrower evidence around it.

## Residual limits accepted for the pilot

- Anchors prove the local repository and packaged adapters, not production or
  customer outcomes.
- The Codex Stop hook is a local guardrail; CI remains the durable enforcement
  surface.
- Graph runs are single-process and journal-replayed. Cross-process locking and
  distributed execution are outside this pilot.
- Linking a run to a proposal is correlation only. Cross-machine orchestration
  requires a future separately modelled change.

No unresolved behavioral gap remains for this pilot scope.
