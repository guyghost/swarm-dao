# Ship Audit Challenge — Model Review

Review of `models/ship-audit.md` and `models/ship-audit.graph.json` before
implementation. Every gap found during review must be resolved before the
model hash is submitted for human approval.

## Nominal transitions

| # | Scenario | Expected |
| --- | --- | --- |
| N1 | Challenge disabled (default) | No audit context is created; `dao_ship` executes as before — behavior identical to pre-feature |
| N2 | First ship call, challenge enabled | `fresh → challenged`; AUDIT_REQUIRED returned; fingerprint + `challengeCount = 1` recorded; nothing executes |
| N3 | Second call, identical fingerprint | `challenged → confirmed`; ship proceeds to `ShipProposalUseCase` |
| N4 | Second call after a vote changed | `challenged → challenged` with the new fingerprint; `challengeCount += 1`; AUDIT_REQUIRED again; prior audit void |
| N5 | Execution attempt made | `confirmed → fresh` via `SHIP_CONSUMED`; a later ship (e.g. execution failed, proposal still `controlled`) starts a new cycle |
| N6 | `--force` with challenge enabled | `fresh/challenged → bypassed`; executes; reason recorded in the audit trail |

✅ All nominal paths are represented in the spec's transition table and are
implementable with pure state + injected fingerprints.

## Invalid transitions and permissions

| # | Scenario | Expected |
| --- | --- | --- |
| P1 | `SHIP_REQUESTED` with source `ai` or `human` | Rejected and journaled — only the deterministic handler may request |
| P2 | `FORCE_OVERRIDE` / `CANCEL` with source `ai` or `system` | Rejected — human-only escape hatches |
| P3 | Any event while `bypassed` or `cancelled` | Rejected — terminal immutability (INV-5) |
| P4 | `SHIP_CONSUMED` from any state but `confirmed` | Rejected — single spend (INV-6) |
| P5 | Audit machine attempts any proposal transition | Impossible by construction (`proposalStateAuthority: "none"`); wiring tests assert the proposal machine remains the only path to `executed` |

✅ Sources are enumerated in the events table; no AI source exists anywhere in
the model (INV-3).

## Cancellation and terminal-state immutability

- `CANCEL` reaches `cancelled` from any active state; `cancelled` and
  `bypassed` are `final`. ✅
- After terminal states, a *new* audit cycle can only begin by creating a new
  context (a new ship call on a still-`controlled` proposal recreates `fresh`
  if no context exists). Documented in the spec's cycle semantics. ✅

## Errors and explicitly modelled retry behavior

- The challenge has **no automatic retry**: re-challenging is not a retry but
  a new challenge caused by a changed fingerprint (N4). `maxRetries = 0` is
  frozen in the graph contract. ✅
- Fingerprint computation failures (malformed proposal) fail closed: the
  handler returns an error, nothing executes, no transition occurs. ✅

## Deterministic time and identifiers

- Timestamps are injected as event payloads; the machine reads no clock. ✅
- Context identity is the proposal id (immutable correlation, INV-4). ✅
- Fingerprints are sha256 over canonical JSON of decision-relevant fields. ✅

## Absence of direct LLM-driven transitions

- No AI worker node exists in the graph; no event carries source `ai`. The
  confirmation is a deterministic property of two identical requests. ✅

## Repository isolation and presenter independence

- Snapshots persist via an injected store port (`.dao/ship-audits/`); the
  machine performs no I/O. ✅
- Presenters render AUDIT_REQUIRED guidance without decisions. ✅

## Open items resolved during review

| Item | Resolution |
| --- | --- |
| What counts as "changed"? | The fingerprint covers id, title, type, description, status, dependsOn, votes (position + weight, ordered), control summary (allGatesPassed, blockerCount). Anything that changes the decision re-challenges. |
| Does `--force` skip only the challenge? | Yes — dependency checks and gates still run inside `ShipProposalUseCase`; the bypass only satisfies INV-1, and it is recorded. |
| Is `confirmed` single-use? | Yes — `SHIP_CONSUMED` resets to `fresh` (INV-6), so a failed execution forces a genuine new confirmation cycle. |
| Disabled-mid-cycle? | The handler consults config on every call; a disabled challenge makes the machine a no-op (N1) without mutating existing contexts. |

**Verdict: ready for exact-hash human approval.**
