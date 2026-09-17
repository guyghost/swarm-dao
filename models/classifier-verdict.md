# Classifier verdict (decision contract)

- **Status**: Implemented in `packages/core/src/domain/classifier-verdict.ts`
- **Kind**: Stateless decision contract (not an XState machine)
- **Scope**: Cheap typed routing for a coding-loop turn. Generation produces
  artifacts; this contract consumes closed-vocabulary JSON plus tool evidence.

Same rationale as `models/agent-runtime.md`: given
`(raw model output, tool evidence, retry budget)` the functions return a
typed decision. There is no journaled run, no terminal immutability concern.
The LLM never selects a Graph Engineering or proposal state.

## Why not a machine

`evaluateAttempt` is a synchronous pure function. Loop counters are supplied
by the caller (the implementing harness or Graph Engineering attempt). Inner
retries do not leave `implementing`. Outer retries after failed anchors are
owned by `evaluateGraphAttempt`.

## Inputs

1. Model output: a JSON object with keys `status`, `confidence`,
   `failureType`, `nextAction`, `affectedPaths`, `reason` only.
2. Tool evidence: `tests` / `types` / `lint` each
   `passed | failed | blocked | not_run`.
3. Attempt state: `retryCount`, `maxRetries` (inner, default 5),
   `minConfidence` (default 0.5).

## EVALUATE-style order (`evaluateAttempt`)

1. Invalid JSON or schema → `re_prompt` (return `errors` to the model).
2. Any tool `blocked` → `block` (environment, not a product failure).
3. `status === escalate` or `confidence < minConfidence` → `escalate`.
4. Any tool `failed` → `continue` (overrides a lying `done`); escalate if
   inner budget is exhausted.
5. `status === done` with no passing tool → `continue` / `run_tests`.
6. `status === done` with at least one passing tool → `request_evaluation`
   (Graph `IMPLEMENTATION_READY` / `EVALUATE`, never `succeeded`).
7. Else `continue` while budget remains, else `escalate`.

## Invariants

- Unknown keys, out-of-range confidence, and unnormalizable paths fail closed.
- Paths use `normalizeEditPath` and `MAX_EDIT_PATHS` (200) from the edit gate.
- Cross-field rules live in the validator, not the prompt (`CLASSIFIER_CHARTER`
  is the model-facing copy of those rules).
- AI output cannot authorize a retry, skip anchors, or emit `MODEL_APPROVED`.

## Implementing harness

The Graph Engineering host (`runGraphImplementing` in
`packages/graph-engineering/src/implementing.ts`, CLI
`swarm-dao graph implement`) prepends `CLASSIFIER_CHARTER`, harvests the last
JSON object, runs cheap tools on `done` / `run_tests`, and routes on
`evaluateAttempt`. `request_evaluation` submits `IMPLEMENTATION_READY`.
Exhausted inner budget submits `IMPLEMENTATION_FAILED` (outer auto-retry).
Human escalate and environment block submit nothing — the run stays
`implementing`. The harness never emits `EVALUATE`.
