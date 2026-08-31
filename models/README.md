# Swarm DAO Behavioral Models

This directory is the architectural source of truth for workflows and state decisions.
Executable XState models live under `packages/core/src/models`; documentation here explains
their boundaries and review status.

## Dependency direction

```text
hosts -> adapters -> application -> models/domain
                    |             ^
                    +-- ports ----+

presenters <- hosts/application results
```

Invariants:

1. Models own every business-state transition.
2. Models and domain rules perform no I/O and use no ambient clock, randomness, or host SDK.
3. Application use cases orchestrate models and ports; they never import infrastructure adapters.
4. AI workers produce typed signals. They never select a target state.
5. Repositories are instance-owned. A host may not use process-global state as its runtime boundary.
6. Presenters transform structured results and contain no business decisions.

## Effect model

Application workflows follow this shape:

```text
command + current state + injected inputs
  -> model/domain decision
  -> next state + structured result
  -> application persists through the repository port
  -> host shell performs remaining technical effects
```

## Proposal lifecycle

States: `open`, `deliberating`, `approved`, `controlled`, `executed`, `failed`, `rejected`.

| From | Event | Guard | To |
|---|---|---|---|
| open | DELIBERATE | — | deliberating |
| deliberating | APPROVE | approved tally | approved |
| deliberating | REJECT | — | rejected |
| approved | CONTROL_PASS | all gates passed, no blocker | controlled |
| approved | CONTROL_FAIL / FAIL | — | failed |
| controlled | EXECUTE_SUCCESS | — | executed |
| controlled | FAIL | — | failed |
| any non-terminal | DISCARD | — | rejected |
| any non-terminal | ERROR | — | failed |

Terminal states are immutable. Rollback is a compensating technical action based on an execution
snapshot; it does not rewrite the historical proposal lifecycle.

AI worker outputs are signals only: agent text is parsed into votes and scores, then deterministic
tally, gate, and lifecycle policies select the permitted event and transition.

## Graph Engineering change control

`graph-engineering.md` and `graph-engineering.graph.json` define a separate
repository-local workflow for Codex change runs. Its executable XState model
lives in `packages/core/src/models/graph-engineering.machine.ts`.

This workflow never owns or mutates proposal status and never writes `.dao/`.
It gates implementation through exact-hash human approval and six deterministic
anchors while the proposal lifecycle above remains the sole business-state
authority.

## Improvement loop (self-improvement cycle)

`improvement-loop.md` and `improvement-loop.graph.json` define a
self-improvement layer that sits *above* the proposal lifecycle and Graph
Engineering change control. Its executable XState model lives in
`packages/core/src/models/improvement-loop.machine.ts`.

The loop pairs an optimizing metric against a counter-metric, audits drift,
arbitrates the paired signal deterministically, and only succeeds when six
ground-contact anchors pass. It never owns proposal or graph-engineering state
(`proposalStateAuthority: "none"`). Drift-detached routes to human reference
review; the frozen set of anchors and commands cannot be unfrozen without an
exact-hash human reference change. AI workers (sensor, counter-sensor,
drift-auditor) emit signals only; the deterministic arbitrator and anchor
verifier decide outcomes.

| command | anchor |
|---|---|
| `bun run improvement:validate` | counter-metric-paired |
| `bun test packages/core/tests/improvement-loop.machine.test.ts` | drift-audit |
| `bun test packages/core/tests/improvement-loop.arbitration.test.ts` | arbitration-policy |
| `bun run improvement:anchors` | anchor-reality |
| `bun test packages/core/tests/improvement-loop.frozen.test.ts` | frozen-set-intact |
| `bun run improvement:regression` | regression |

## Improvement orchestrator (continuous series)

`improvement-orchestrator.md` and `improvement-orchestrator.graph.json` define
the continuous series layer that sits above the improvement loop: one series
runs repeated improvement cycles on a fixed scope and reference, scheduling the
next cycle only while cycles succeed. Its executable XState model lives in
`packages/core/src/models/improvement-orchestrator.machine.ts`; the herdr
worker executor and the series CLI live in `tools/improvement-loop/workers.ts`
and `tools/improvement-loop/orchestrator.ts`.

The orchestrator is correlation plus effect execution only: it never owns
cycle state, never submits a human-source event to any machine, and pauses on
the same human gates as the cycles it runs (`awaitingHumanCycleDecision`,
`workerFailed`, `halted`). Series evidence under `evidence/improvement-series/`
is gitignored.

| command | purpose |
|---|---|
| `bun run improvement:series:init` | start a series (human; scope, reference hash, cooldown) |
| `bun run improvement:series:status` | show the persisted series snapshot |
| `bun run improvement:series:submit` | forward a human event (retry/restart/cancel) |
| `bun run improvement:series:once` | execute the single effect authorized by the current state |

## Product loop (continuous product-loop)

`product-loop.md` and `product-loop.graph.json` define the continuous
product-loop workflow that evolves proposals/tasks/voting from human-triggered
steps into a controlled automatic loop. Its executable XState model lives in
`packages/core/src/models/product-loop.machine.ts`.

The loop runs Exploration → Proposition → Qualification → Vote → Adopted →
Execution → Verification → Ship → Observation → Validated, with deterministic
detours to Rejected (vote expiry), BudgetBlocked → Review (budget exhaustion),
Rollback (consecutive-measurement degradation), and Review (sensitive, failed,
or incomplete verification). Auto-ship applies only to allowed reversible
technical improvements; security proposals that touch permissions, secrets,
payments, or sensitive data are auto-qualified and auto-voted but require human
Review before deployment. Every transition is decided by the model — AI workers
(explorer, feedback-aggregator, proposer) produce signals and drafts only. The
human owner is the sole authority for budget expansion, scope reduction,
abandonment, verification retry, contact-relay authorization, and cancellation.

| command | anchor |
|---|---|
| `bun run product:validate` | qualification-passed |
| `bun test packages/core/tests/product-loop.regression.test.ts` | vote-quorum |
| `bun test packages/core/tests/product-loop.regression.test.ts` | budget-envelope |
| `bun test packages/core/tests/product-loop.machine.test.ts` | controls-passed |
| `bun test packages/core/tests/product-loop.regression.test.ts` | auto-ship-policy |
| `bun test packages/core/tests/product-loop.regression.test.ts` | observation-window |
| `bun run product:anchors` | rollback-path-exists |
| `bun test packages/core/tests/product-loop.frozen.test.ts` | frozen-set-intact |
| `bun run product:regression` | regression |


## Ship audit challenge (ship confirmation)

`ship-audit.md` and `ship-audit.graph.json` define the swarm-forge-style
`AUDIT_REQUIRED` gate for proposal shipping: with `ship.auditChallenge`
enabled in `.dao/config.json`, the first `dao_ship` call challenges instead
of executing; only an unchanged second call executes (fingerprint-bound to
the decision content); `--force` is an audited human bypass. Its executable
model lives in `packages/core/src/models/ship-audit.machine.ts`. It never
owns proposal state (`proposalStateAuthority: "none"`) and has no AI role —
confirmation is a deterministic property of two identical requests.

| command | anchor |
| --- | --- |
| `bun run shipaudit:validate` | audit-model-contract |
| `bun test packages/core/tests/ship-audit.machine.test.ts tools/ship-audit/tests` | audit-graph-tests |
| `bun test packages/core/tests/ship-audit.wiring.test.ts` | audit-wiring-contract |
| `bun run shipaudit:regression` | audit-regression |
| `bun run shipaudit:demo` | audit-runtime-scenario |

## Review checklist

Before adding or changing a workflow, cover:

- nominal transitions;
- invalid transitions and permissions;
- cancellation and terminal-state immutability;
- errors and explicitly modelled retry behavior;
- deterministic time and identifiers;
- absence of direct LLM-driven transitions;
- repository isolation and presenter independence.
