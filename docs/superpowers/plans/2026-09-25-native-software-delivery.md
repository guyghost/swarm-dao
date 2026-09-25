# Native Software Delivery Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Build a restartable local delivery coordinator joining an adopted Product Loop task to an exact-hash-approved Graph Engineering implementation, reversible staging, observation, rollback, and a durable scorecard.

**Architecture:** Put the pure machine in `packages/core` and add reusable runtime code in `@guyghost/swarm-dao-software-delivery`. Extend the CLI to inject its existing Graph coding-agent adapter.

**Tech Stack:** TypeScript, Bun, XState 5, Node.js filesystem APIs, NDJSON journals, existing Graph and Product runners. No third-party runtime dependency.

**Spec:** [docs/superpowers/specs/2026-09-25-native-software-delivery-design.md](../specs/2026-09-25-native-software-delivery-design.md)

## Global Constraints

- Local, single-process pilot in this repository.
- Each child machine remains the sole authority for its state and policy.
- Product Loop intake requires `execution`, sealed quorum evidence, and an active budget.
- Legacy proposal IDs provide correlation only.
- Graph Engineering requires human `MODEL_APPROVED` for the exact hash.
- AI cannot vote, approve, authorize, spend budget, waive anchors, retry, cancel, or grant permission.
- Unknown risk pauses before implementation; it never defaults to standard.
- Security category or `touchesSensitive === true` requires human deploy review.
- Ship only to a reversible non-production target; missing capability stops at `awaiting-capability`.
- Unavailable cost/customer/incident data is never zero.
- Effects are journaled with stable idempotency keys; ambiguous effects stop for review.
- Rollback ends that delivery instance; the corrective task starts a new run.
- Do not use Builder.io Factory or its skill.
- Owner approval of the exact delivery-model hash through Graph Engineering is required before core implementation.

## Review Focus

1. Forged authority, stale model hashes, and mismatched run IDs must be rejected.
2. Restart between effect and result must reconcile before retry.
3. Child intake must reject wrong Product state, missing quorum/budget anchors, and exhausted budget.
4. Unknown/sensitive routes and changed-scope reviews must not bypass gates.
5. Active runs, incomplete observations, and unavailable metrics must not distort denominators.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `models/software-delivery.md`, `models/software-delivery.review.md` | Create | State, event, authority, failure, and review contract. |
| `models/software-delivery.graph.json`, `models/software-delivery.graph.schema.json` | Create | Frozen graph nodes, edges, anchors, commands, and schema. |
| `packages/core/src/models/software-delivery.machine.ts` | Create | Pure XState coordination machine. |
| `packages/core/src/models/index.ts` | Modify | Export the model. |
| `packages/core/tests/software-delivery.*.test.ts` | Create | Machine, regression, and frozen tests. |
| `packages/software-delivery/package.json` | Create | New runtime workspace package. |
| `packages/software-delivery/src/{signal,runner,child-runs,executor,staging-target,observations,scorecard,cli}.ts` | Create | Validated signals, journals, child adapters, effects, local stage, observation, metrics, and command handler. |
| `packages/software-delivery/tests/*.test.ts` | Create | Unit and integration tests per boundary. |
| `packages/cli/src/cli.ts` | Modify | Add `swarm-dao delivery` and inject existing Graph worker adapter. |
| `packages/cli/tests/software-delivery.test.ts` | Create | CLI parsing, gates, host injection, exit codes. |
| `tools/software-delivery/{contract,validate,anchors,demo}.ts` | Create | Model/hash validator, frozen anchors, reference scenario. |
| `package.json` and `packages/cli/package.json` | Modify | Workspace dependency and command scripts. |
| `tsconfig.tests.json` and `tools/tsconfig.json` | Modify | Type resolution for the new package. |
| `.gitignore` | Modify | Ignore delivery journals and staging artifacts. |
| `.changeset/native-software-delivery.md` | Create | Version core, CLI, and runtime package. |
| `docs/USAGE.md` | Modify | Pilot setup, gates, commands, and metric limits. |

## Task 1: Define and Approve the Delivery Model

**Files:** Create the four `models/software-delivery*` files.

**Interfaces:** Graph ID `swarm-dao-software-delivery`; evidence root `evidence/software-deliveries`. Terminal outcomes: `validated`, `rolledBack`, `failed`, `blocked`, `cancelled`, `rejected`.

- [x] **Step 1: Define states, events, and the intake gate**

  Specify `intake`, `awaitingRiskReview`, `draftingGraphModel`, `validatingGraphModel`, `awaitingGraphApproval`, `graphReady`, `implementing`, `productVerification`, `awaitingShipReview`, `shipReady`, `awaitingShipCapability`, `observing`, and terminal outcomes. Keep these names identical to the approved spec. Product Loop must enter at `execution` with sealed `vote-quorum` and `budget-envelope` anchors. Unknown risk requires evidence-backed human resolution before model preparation.

- [x] **Step 2: Define nodes, authority edges, anchors, and forbidden transitions**

  Include deterministic intake, contract, child-run, executor, staging, and observation nodes; an AI signal-only modeler; and a human owner. Set `proposalStateAuthority: "none"`. Freeze commands for contract validation, machine tests, architecture contracts, rollback proof, runtime scenario, and regression. Write the full transition/review matrix.

- [x] **Step 3: Parse JSON and print the exact model hash**

  ```bash
  bun -e 'for (const p of ["models/software-delivery.graph.json", "models/software-delivery.graph.schema.json"]) JSON.parse(await Bun.file(p).text()); console.log("delivery JSON syntax: valid")'
  bun -e 'import { createHash } from "node:crypto"; const paths = ["models/software-delivery.md", "models/software-delivery.graph.json"]; let manifest = ""; for (const p of paths) manifest += createHash("sha256").update(new Uint8Array(await Bun.file(p).arrayBuffer())).digest("hex") + "  " + p + "\n"; console.log(createHash("sha256").update(manifest).digest("hex"))'
  ```

  Expected: both JSON files parse; the second command prints one 64-character digest. The ordered manifest contains model Markdown and graph JSON only.

- [x] **Step 4: Obtain exact-hash approval through Graph Engineering**

  Submit `MODEL_APPROVED` as a human event in the existing Graph run using that digest. Stop here until the owner approves the exact hash. Spec or plan approval is not model approval.

- [x] **Step 5: Commit the model contract**

  ```bash
  git add models/software-delivery.md models/software-delivery.review.md models/software-delivery.graph.json models/software-delivery.graph.schema.json
  git commit -m "docs: model native software delivery orchestration"
  ```

## Task 2: Implement the Pure Parent State Machine

**Files:** Create `packages/core/src/models/software-delivery.machine.ts` and `packages/core/tests/software-delivery.machine.test.ts`, `packages/core/tests/software-delivery.regression.test.ts`; modify `packages/core/src/models/index.ts`.

**Interfaces:** Export `softwareDeliveryMachine`, `createSoftwareDeliveryActor(input)`, `SoftwareDeliveryContext`, `SoftwareDeliveryEvent`, `DeliveryRiskClass`, and `DeliveryTerminalOutcome`. Context stores run IDs, immutable proposal correlation, scope hash, initial/current risk, model/implementation/artifact hashes, effect checkpoint, and outcome; it never embeds child contexts.

- [x] **Step 1: Write risk-gate tests**

  ```ts
  it("holds unknown risk before model preparation", () => {
    const actor = createSoftwareDeliveryActor(input({ riskClass: "unknown" }));
    actor.send({ type: "INTAKE_ACCEPTED", source: "tool", evidence: "product-journal:8" });
    expect(actor.getSnapshot().value).toBe("awaitingRiskReview");
  });
  ```

  Also assert only a human `RISK_CLASSIFICATION_RESOLVED` with evidence leaves review, and initial risk remains `"unknown"`.

- [x] **Step 2: Write exact-hash, sensitive, rollback, and cancellation tests**

  ```ts
  it("does not accept approval for another Graph hash", () => {
    const actor = actorAwaitingGraphApproval("model-hash-1");
    actor.send({ type: "GRAPH_APPROVAL_CONFIRMED", source: "tool", modelHash: "model-hash-2", evidence: "graph:4" });
    expect(actor.getSnapshot().value).toBe("awaitingGraphApproval");
  });
  ```

  Test that sensitive work waits for Product review, rollback requires corrective-proposition evidence, tool cancellation is rejected, and terminal states ignore later events.

- [x] **Step 3: Implement the typed pure XState model**

  Define events/context, guards, and transitions with XState 5 `setup({ types, guards, actions })`. Use no Node imports, async effects, filesystem, randomness, or ambient clock. Start actors through `createSoftwareDeliveryActor(input)`.

- [x] **Step 4: Export and run focused tests**

  ```ts
  // packages/core/src/models/index.ts
  export * from "./software-delivery.machine.js";
  ```

  Run: `bun test packages/core/tests/software-delivery.machine.test.ts packages/core/tests/software-delivery.regression.test.ts`.

  Expected: PASS for risk/hash gates, child outcomes, human-only actions, rollback, cancellation, and terminal rejection.

- [x] **Step 5: Commit**

  ```bash
  git add packages/core/src/models/software-delivery.machine.ts packages/core/src/models/index.ts packages/core/tests/software-delivery.machine.test.ts packages/core/tests/software-delivery.regression.test.ts
  git commit -m "feat(core): add software delivery coordination model"
  ```

## Task 3: Add Signal Validation and Workspace Wiring

**Files:** Create `packages/software-delivery/package.json`, package `src/index.ts` and `src/signal.ts`, signal tests, `tools/software-delivery/contract.ts`, `validate.ts`, and contract tests. Modify root/CLI manifests and test/tool path mappings.

**Interfaces:** Package name `@guyghost/swarm-dao-software-delivery`. Export `DeliverySignal`, `validateDeliverySignal`, `computeDeliveryModelHash`, and `validateDeliveryContract(rootDirectory)`. Signal shape: `{ runId, type, source, producer, occurredAt, payload, evidence }`.

- [x] **Step 1: Write source/producer rejection tests**

  ```ts
  it("rejects a modeler attempting to cancel a delivery", () => {
    const result = validateDeliverySignal(signal({ type: "CANCEL", source: "human", producer: "modeler" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toMatch(/producer|CANCEL/);
  });
  ```

  Add cases for unknown events, wrong source, empty evidence, nested transition keys, AI authority keys, invalid risk, stale run ID, and malformed hash.

- [x] **Step 2: Implement the frozen graph/model validator**

  Check JSON schema, fixed ID/version/scope/evidence root, machine state/event sets, node order, authority edges, anchor commands, and ordered model hash. Return `{ valid, issues, modelHash }`.

- [x] **Step 3: Implement the producer-bound signal validator**

  Bind each event to one source and producer from the frozen graph; map accepted payloads to `SoftwareDeliveryEvent`. Never construct a human event from a tool or AI signal.

- [x] **Step 4: Wire package and scripts**

  Add the workspace dependency to root and CLI manifests; add path mappings in `tsconfig.tests.json` and `tools/tsconfig.json`; add `software-delivery:validate`.

- [x] **Step 5: Run focused checks and commit**

  Run `bun test packages/software-delivery/tests/signal.test.ts tools/software-delivery/tests/contract.test.ts` and `bun run software-delivery:validate`.

  Expected: PASS, one printed model hash, no parity issues.

  ```bash
  git add packages/software-delivery/package.json packages/software-delivery/src/index.ts packages/software-delivery/src/signal.ts packages/software-delivery/tests/signal.test.ts tools/software-delivery/contract.ts tools/software-delivery/validate.ts tools/software-delivery/tests/contract.test.ts package.json packages/cli/package.json tsconfig.tests.json tools/tsconfig.json
  git commit -m "feat(delivery): validate producer-bound signals"
  ```

## Task 4: Add the Replayable Delivery Runner

**Files:** Create `packages/software-delivery/src/runner.ts` and `packages/software-delivery/tests/runner.test.ts`.

**Interfaces:** Export `PersistedDeliverySnapshot`, `DeliverySubmissionResult`, `DeliveryRunner`, and `createDeliveryRunner({ evidenceRoot, runId, clock? })`. Provide cloned `snapshot()` and serialized `submit(input)` matching sibling runners.

- [x] **Step 1: Write replay and rejected-event tests**

  ```ts
  it("replays accepted signals and retains rejected signals without state change", async () => {
    const first = await createDeliveryRunner(options);
    expect((await first.submit({ ...validStart, source: "ai" })).accepted).toBe(false);
    await first.submit(validStart);
    const resumed = await createDeliveryRunner(options);
    expect(resumed.snapshot().state).toBe("draftingGraphModel");
    expect((await readJournal(options)).map((row) => row.sequence)).toEqual([1, 2]);
  });
  ```

  Add corrupt line, sequence gap, accepted record without signal, nondeterministic replay, unsafe run ID, and concurrent writer cases.

- [x] **Step 2: Implement safe journal storage and replay**

  Reject IDs outside `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` and any ID containing `..`. Store `journal.ndjson` and `snapshot.json` under `<evidenceRoot>/<runId>`. Replay accepted events through signal validation and the actor; retain rejected entries without sending them.

- [x] **Step 3: Persist effect intent and completion**

  Derive keys from delivery ID, effect name, and child attempt. Append intent before an effect and result/evidence after it. A repeated completed key returns its prior result. Reconcile pending keys against child journals or stage state before retry.

- [x] **Step 4: Add sequence concurrency protection**

  Re-read the journal tail before append; fail without writing when the disk sequence differs. Test a second runner advancing the file and a corrupt tail.

- [x] **Step 5: Verify and commit**

  Run: `bun test packages/software-delivery/tests/runner.test.ts`.

  Expected: PASS with deterministic replay and retained rejected events.

  ```bash
  git add packages/software-delivery/src/runner.ts packages/software-delivery/tests/runner.test.ts
  git commit -m "feat(delivery): persist and replay delivery runs"
  ```

## Task 5: Build Child Adapters and the One-Effect Executor

**Files:** Create `packages/software-delivery/src/child-runs.ts`, `executor.ts`, child/executor tests; update `src/index.ts`. Permit the existing Product Loop `deploy-authorized` signal in its validator so the delivery coordinator can verify that human decision from the accepted Product journal.

**Interfaces:** Export `DeliveryExecutorPorts`, `DeliveryAdvanceResult`, and `advanceDeliveryOnce(runner, ports)`. Ports read/submit Product and Graph runs, create Graph runs, invoke the existing implementation harness, verify anchors, ship/rollback, sample observations, and provide a clock. One call performs at most one effect and returns `advanced`, `waiting-human`, `waiting-capability`, `waiting-observation`, or `terminal`.

- [x] **Step 1: Write Product child intake tests**

  ```ts
  it("accepts execution with sealed quorum and remaining budget", async () => {
    const result = await inspectProductChild("product-7", productSnapshot({
      state: "execution",
      anchors: {
        "vote-quorum": { status: "passed", evidence: "vote:4" },
        "budget-envelope": { status: "passed", evidence: "budget:1" },
      },
      budget: { initial: 20, consumed: 2, history: [] },
    }));
    expect(result.kind).toBe("ready");
  });
  ```

  Reject wrong ID/state, missing anchors, exhausted budget, invalid journal, and a rollback artifact outside the configured stage target.

- [x] **Step 2: Implement child reconciliation without cross-machine mutation**

  Open children with `createProductRunner({ evidenceRoot, runId })` and `createGraphRunner({ evidenceRoot, runId })`. Read snapshots and accepted journal entries. Submit transitions only through child `submit()` APIs.

- [x] **Step 3: Write effect-order tests with fake ports**

  ```ts
  it("starts implementation only after Graph is in implementing", async () => {
    const ports = fakePorts({ productState: "execution", graphState: "ready" });
    const result = await advanceDeliveryOnce(await deliveryRun(), ports);
    expect(ports.calls).toEqual(["read-product", "read-graph", "start-implementation"]);
    expect(result.kind).toBe("advanced");
  });
  ```

  Assert no worker before exact approval, Graph success before Product `EXECUTION_DONE`, and pauses for Product review, child failure, cancellation, or missing ship capability.

- [x] **Step 4: Implement intent/reconcile/effect/result ordering**

  Reload parent and children; validate states/IDs; append intent; perform one effect; append evidence/result; then advance the parent. Generate the Graph child ID deterministically from parent ID. Ambiguous non-idempotent effects return `waiting-human` without repeating.

- [x] **Step 5: Verify and commit**

  Run: `bun test packages/software-delivery/tests/child-runs.test.ts packages/software-delivery/tests/executor.test.ts`.

  Expected: PASS and every child transition went through its runner.

  ```bash
  git add packages/software-delivery/src/child-runs.ts packages/software-delivery/src/executor.ts packages/software-delivery/src/index.ts packages/software-delivery/tests/child-runs.test.ts packages/software-delivery/tests/executor.test.ts
  git commit -m "feat(delivery): coordinate graph and product runners"
  ```

## Task 6: Implement Reversible Staging, Budget, and Observation

**Files:** Create `packages/software-delivery/src/staging-target.ts`, `observations.ts`, and both test files.

**Interfaces:** `createLocalStagingTarget({ stageRoot, snapshotSource })` exposes `initialize()`, `snapshot()`, `inspect()`, `ship({ effectId, artifact })`, and `rollback({ effectId, expectedActiveHash })`. Artifacts are immutable and SHA-256 keyed; initial baseline is an empty active pointer.

- [ ] **Step 1: Write stage and rollback tests**

  ```ts
  it("ships one immutable artifact and restores the empty baseline", async () => {
    const target = createLocalStagingTarget({ stageRoot, snapshotSource: fakeSnapshot("patch-a") });
    await target.initialize();
    const result = await target.ship({ effectId: "delivery-1:ship:1", artifact: await target.snapshot() });
    expect((await target.inspect()).activeHash).toBe(result.artifactHash);
    await target.rollback({ effectId: "delivery-1:rollback:1", expectedActiveHash: result.artifactHash });
    expect((await target.inspect()).activeHash).toBeNull();
  });
  ```

  Also test duplicate effects, altered pointer, missing blob, interrupted pointer update, and rollback replay.

- [ ] **Step 2: Implement immutable storage and atomic pointer updates**

  Write under `<stageRoot>/artifacts/<sha256>`; verify before atomically replacing `active.json`. Preserve previous blobs. Return prior result for a completed effect key. Rollback checks current hash before restoring the previous pointer.

- [ ] **Step 3: Write observation omission tests**

  ```ts
  it("omits unavailable provider cost and records measured staging checks", async () => {
    const samples = await createStagingObservationSamples({
      inspect: async () => ({ intact: true, errorCount: 0, checkLatencyMs: 3 }),
      providerCost: { available: false },
    });
    expect(samples.map((sample) => sample.metric)).toEqual(["errors", "latency"]);
    expect(samples.some((sample) => sample.metric === "aiCost")).toBe(false);
  });
  ```

  Require three actual clean measurements and the configured window before Product Loop evaluation. Missing customer/provider data produces no sample.

- [ ] **Step 4: Charge budget before Graph implementation**

  Require positive immutable `creditsPerGraphAttempt`. Submit `BUDGET_CHARGE` through ProductRunner's `budget-ledger` producer before `runGraphImplementing`. If rejected or Product enters review, do not invoke the worker. Credits are task units, not money; monetary `aiCost` is reported only when measured by the host.

- [ ] **Step 5: Verify rollback proof and gate ship**

  Require Product `draft.rollbackArtifact` to resolve to the configured active pointer; prove it is readable and restorable before recording `rollback-path-exists`. Ship only when ProductRunner is in `ship`. Sensitive work waits for the Product runner's human deploy approval and resulting `ship` state.

- [ ] **Step 6: Verify and commit**

  Run: `bun test packages/software-delivery/tests/staging-target.test.ts packages/software-delivery/tests/observations.test.ts`.

  Expected: PASS; rollback restores prior state and observations reflect measured checks only.

  ```bash
  git add packages/software-delivery/src/staging-target.ts packages/software-delivery/src/observations.ts packages/software-delivery/tests/staging-target.test.ts packages/software-delivery/tests/observations.test.ts
  git commit -m "feat(delivery): add reversible staging and observations"
  ```

## Task 7: Add the Scorecard and Operator CLI

**Files:** Create `packages/software-delivery/src/scorecard.ts`, scorecard/CLI tests; modify package exports and `packages/cli/src/cli.ts`.

**Interfaces:** Export `buildDeliveryScorecard(entries, { now, since? })` and `runDeliveryCommand(argv, dependencies)`. Commands: `init`, `status`, `submit`, `once`, `resume`, `scorecard`, `stage-init`.

- [ ] **Step 1: Write denominator and availability tests**

  ```ts
  it("reports unavailable rates when no eligible terminal run exists", () => {
    const scorecard = buildDeliveryScorecard([activeRunJournal()], { now: NOW });
    expect(scorecard.completion.rate).toBeNull();
    expect(scorecard.completion.denominator).toBe(0);
    expect(scorecard.activeRuns).toBe(1);
  });
  ```

  Test formulas for post-approval autonomy, all terminal outcomes including rollback, human intervention, retries, failed controls, rollback, incomplete observation, unknown initial risk, missing cost, and nearest-rank p95.

- [ ] **Step 2: Implement the pure journal reducer**

  Return `{ numerator, denominator, rate }`; `rate` is null when denominator is zero. Define post-approval autonomy as validated runs that reached their outcome without human action after exact-hash approval, divided by approved runs whose observations reached a terminal outcome. Define end-to-end completion as `validated` divided by all terminal delivery runs. Define rollback as confirmed rollbacks divided by shipped runs with a determined `validated` or `rolledBack` outcome. Also report human intervention, retries, failed controls, active runs, incomplete observation, and unavailable data separately. Count `validated`, `rolledBack`, `failed`, `blocked`, `cancelled`, and `rejected` as terminal outcomes. Do not use run IDs, paths, prompts, or identities as aggregate labels.

- [ ] **Step 3: Add the CLI using the current Graph worker adapter**

  Route `delivery` in `packages/cli/src/cli.ts`. Reuse `childSessionOptionsFrom`, `childAdapter`, `IMPLEMENTATION_AGENT`, and `runGraphImplementing` through injected `ImplementingPorts`. Charge Product budget before worker invocation. Never synthesize child approval, Product review, or child cancellation.

- [ ] **Step 4: Implement parsing, status, pauses, and exit codes**

  `init` requires `--delivery-id` and `--product-run-id`. Accept `--evidence-root`, `--stage-root`, positive `--credits-per-graph-attempt`, and positive `--observation-window-ms` and `--observation-interval-ms`. `status` prints child states, required human action, effect checkpoint, evidence path. `once` advances one effect; `resume` stops at a human/capability/observation wait or terminal. `scorecard` shows counts and denominators. `stage-init` seeds/verifies the empty pointer. Exit codes: 0 success, 2 machine rejection, 1 usage/execution error.

- [ ] **Step 5: Test the CLI without a real agent**

  Test flags, malformed signal JSON, each command, no worker before preflight, output, and exit codes using fake dependencies.

  Run: `bun test packages/software-delivery/tests/scorecard.test.ts packages/software-delivery/tests/cli.test.ts packages/cli/tests/software-delivery.test.ts`.

  Expected: PASS with writes limited to temporary roots.

- [ ] **Step 6: Commit scorecard and CLI**

  ```bash
  git add packages/software-delivery/src/scorecard.ts packages/software-delivery/src/index.ts packages/software-delivery/tests/scorecard.test.ts packages/software-delivery/tests/cli.test.ts packages/cli/src/cli.ts packages/cli/tests/software-delivery.test.ts
  git commit -m "feat(cli): expose software delivery and scorecard"
  ```

## Task 8: Complete Integration, Anchors, Docs, and Release Metadata

**Files:** Create integration tests, `tools/software-delivery/anchors.ts`, `demo.ts`, `.changeset/native-software-delivery.md`. Modify model validator, package/root scripts, `.gitignore`, exports, and `docs/USAGE.md`.

**Interfaces:** Root scripts: `software-delivery:validate`, `software-delivery:anchors`, `software-delivery:demo`, `software-delivery:regression`, `software-delivery:stage-init`, `software-delivery:init`, `software-delivery:status`, `software-delivery:once`, `software-delivery:resume`, `software-delivery:scorecard`.

- [ ] **Step 1: Write nominal integration coverage**

  Use temporary Product, Graph, Delivery, and stage roots. Prepare ProductRunner in `execution` with sealed quorum/budget; use fake worker/check ports; submit the exact Graph human approval through GraphRunner.

  ```ts
  it("validates a standard run without direct child-state mutation", async () => {
    const run = await createReferenceScenario({ riskClass: "standard", samples: 3 });
    const result = await run.resumeUntilPauseOrTerminal();
    expect(result.delivery.snapshot().state).toBe("validated");
    expect(result.graph.snapshot().state).toBe("succeeded");
    expect(result.product.snapshot().state).toBe("validated");
  });
  ```

- [ ] **Step 2: Add human-gate and failure integration scenarios**

  Cover stale hash, unknown risk, sensitive review, Product budget review, failed controls, absent ship capability, effect recovery, three rollback measurements, cancellation, unavailable metrics, and corrupt child journals. Assert child transitions go through their own `submit()`.

- [ ] **Step 3: Implement anchors and temporary-root demo**

  Read commands only from the graph JSON; validate hash parity and spawn with `shell: false`. Demo reaches `validated` and `rolledBack` without printing prompts or personal data.

- [ ] **Step 4: Add scripts, evidence ignores, changeset, and operating docs**

  Ignore both evidence roots. Add minor changesets for core, CLI, and the new public runtime package. Document Product `rollbackArtifact: "evidence/software-delivery-stage/active.json"`, stage initialization, Product quorum, delivery start, exact Graph approval, resume/status, scorecard, local-only observations, and no production deploy.

- [ ] **Step 5: Run integration, anchors, typechecks, and canonical CI**

  ```bash
  bun test packages/software-delivery/tests/integration.test.ts
  bun run software-delivery:validate
  bun run software-delivery:anchors
  bun run software-delivery:regression
  bun run typecheck
  bun run typecheck:tools
  bun run ci
  ```

  Expected: anchors and CI pass; demo reaches `validated`; rollback scenario reaches `rolledBack`.

- [ ] **Step 6: Commit the integrated feature**

  ```bash
  git add models/software-delivery.md models/software-delivery.review.md models/software-delivery.graph.json models/software-delivery.graph.schema.json packages/software-delivery packages/core/tests/software-delivery.frozen.test.ts packages/cli tools/software-delivery package.json tsconfig.tests.json tools/tsconfig.json .gitignore .changeset/native-software-delivery.md docs/USAGE.md
  git commit -m "feat: add repository-native software delivery"
  ```

## Dependency Order

```text
Task 1 (model + exact-hash approval)
  -> Task 2 (pure state machine)
  -> Task 3 (signals and contract)
  -> Task 4 (journal runner)
  -> Task 5 (child adapters and executor)
  -> Task 6 (staging, budget, observation)
  -> Task 7 (scorecard and CLI)
  -> Task 8 (integration, anchors, docs, CI)
```

Tasks 2–8 wait for exact-hash approval in Task 1. Every task commits focused files and leaves a runnable targeted test. Task 8 runs `bun run ci` before completion.
