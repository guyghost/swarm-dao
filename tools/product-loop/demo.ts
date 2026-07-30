import { resolve } from "node:path";
import { validateProductContract } from "./contract.js";
import { createProductRunner, type ProductRunner, type ProductSubmissionResult } from "./runner.js";

const root = process.cwd();
const evidenceRoot = resolve(root, "evidence/product-loops");

const contract = await validateProductContract(root);
if (!contract.valid) throw new Error(`product contract invalid: ${contract.issues.join("; ")}`);

// Every reference scenario shares the same reversible, allowed-category
// proposal draft. The AI (proposer) only ever produces this draft as a signal;
// it never selects a target state. The deterministic gates decide every move.
const baseDraft = {
  scope: "demo: cache the rendered proposal digest to cut read latency",
  category: "performance" as const,
  touchesSensitive: false,
  dependencies: ["packages/core/src/models/proposal.machine.ts"],
  budgetAllocation: 80,
  rollbackArtifact: "evidence/rollback/digest-cache-revert.patch",
  evidence: "benchmark: digest render 42ms → 9ms over 1000 reads",
};

type SignalSource = "ai" | "tool" | "human" | "system";

const makeSignal = (
  runId: string,
  type: string,
  source: SignalSource,
  producer: string,
  payload: Record<string, unknown> = {},
  evidence: string[] = [],
) => ({
  runId,
  type,
  source,
  producer,
  occurredAt: new Date().toISOString(),
  payload,
  evidence,
});

type ScenarioResult = Readonly<{
  name: string;
  runId: string;
  expectedState: string;
  actualState: string;
  modelHash: string;
  budget: unknown;
  anchors: unknown;
  controls: unknown;
  evidenceDirectory: string;
  passed: boolean;
}>;

type ScenarioDrive = (helpers: {
  submit: (signal: unknown) => Promise<ProductSubmissionResult>;
  evaluateObservation: (windowElapsed?: boolean) => Promise<string>;
  runId: string;
}) => Promise<void>;

const runScenario = async (name: string, expectedState: string, drive: ScenarioDrive): Promise<ScenarioResult> => {
  const runId = `product-demo-${name}-${Date.now()}`;
  const runner: ProductRunner = await createProductRunner({ evidenceRoot, runId });

  // `submit` is strict: every prefix/sample/open event MUST change the snapshot
  // (transition or record). A no-op here means the reference scenario drifted
  // from the model guards, and we surface it loudly.
  const submit = async (signal: unknown): Promise<ProductSubmissionResult> => {
    const result = await runner.submit(signal);
    if (!result.accepted) throw new Error(`reference scenario event rejected: ${result.issues.join("; ")}`);
    return result;
  };

  // `evaluateObservation` is tolerant by design. OBSERVATION_EVALUATE has three
  // first-class outcomes in the model: confirm degradation (→ rollback), validate
  // the window (→ validated), or HOLD when degradation is unconfirmed AND fewer
  // than N samples exist. The hold is a deliberate guard hold, not a divergence;
  // the journal records it as a non-accepted no-op and the state is unchanged.
  const evaluateObservation = async (windowElapsed = true): Promise<string> => {
    const result = await runner.submit(
      makeSignal(runId, "OBSERVATION_EVALUATE", "system", "product-runner", { windowElapsed }),
    );
    return result.snapshot.state;
  };

  await drive({ submit, evaluateObservation, runId });

  const snapshot = runner.snapshot();
  const actualState = snapshot.state;
  return {
    name,
    runId,
    expectedState,
    actualState,
    modelHash: contract.modelHash,
    budget: snapshot.context.budget,
    anchors: snapshot.context.anchors,
    controls: snapshot.context.controls,
    evidenceDirectory: resolve(evidenceRoot, runId),
    passed: actualState === expectedState,
  };
};

// Shared nominal prefix: exploration → proposition → qualification → vote →
// adopted → execution → verification → ship → observation. The machine itself
// validates scope/category/dependencies/budget, tallies the quorum, opens the
// shared budget envelope, runs the auto-ship gate, and records every auto-sealed
// anchor. External anchors (frozen-set-intact, regression, rollback-path-exists)
// must be recorded by the verifier tool before the runner evaluates the ship gate.
const driveToObservation = async (
  submit: (signal: unknown) => Promise<ProductSubmissionResult>,
  runId: string,
): Promise<void> => {
  // 1. Exploration → Proposition. An AI drafts a proposal; the deterministic
  //    proposition-gate promotes the draft into a tracked proposition.
  await submit(makeSignal(runId, "PROPOSAL_DRAFTED", "ai", "proposer", { draft: baseDraft }, [baseDraft.evidence]));
  await submit(makeSignal(runId, "OPEN_PROPOSITION", "tool", "proposition-gate"));

  // 2. Proposition → Qualification. Qualification carries an affirmative,
  //    evidence-backed permission clearance — it never passes on the mere
  //    absence of a denial. The machine validates everything else deterministically.
  await submit(
    makeSignal(
      runId,
      "QUALIFICATION_RUN",
      "tool",
      "qualifier",
      {
        permissionCleared: true,
        permissionEvidence: "permissions: none required (performance category, no sensitive files)",
      },
      ["permissions: none required (performance category, no sensitive files)"],
    ),
  );

  // 3. Vote. Quorum is a minimum favorable-vote threshold; the runner evaluates
  //    it deterministically once the favorable tally is recorded.
  await submit(
    makeSignal(
      runId,
      "VOTE_OPENED",
      "tool",
      "vote-tally",
      { config: { quorum: 3, kind: "standard", expiryHours: 72 } },
      ["vote opened: quorum 3, standard, 72h expiry"],
    ),
  );
  await submit(makeSignal(runId, "VOTE_CAST", "tool", "vote-tally", { favorable: 3 }, ["3 favorable votes recorded"]));
  await submit(makeSignal(runId, "VOTE_EVALUATE", "system", "product-runner"));

  // 4. Adopted → Execution. The shared budget envelope opens automatically on
  //    adoption; the budget-ledger charges against it.
  await submit(
    makeSignal(
      runId,
      "BUDGET_CHARGE",
      "tool",
      "budget-ledger",
      { action: { amount: 25, description: "implementation spend", evidence: "ledger: impl charge 25" } },
      ["ledger: impl charge 25"],
    ),
  );
  await submit(makeSignal(runId, "EXECUTION_DONE", "tool", "budget-ledger"));

  // 5. Verification. The verifier records a passing control AND the three
  //    external anchors the machine never auto-seals: frozen-set-intact,
  //    regression, and rollback-path-exists. The rollback path is a ship-gate
  //    prerequisite recorded only after the artifact is confirmed genuine.
  await submit(
    makeSignal(
      runId,
      "VERIFY_RUN",
      "tool",
      "verifier",
      { control: { name: "unit-tests", status: "passed", evidence: "bun test: 23 pass" } },
      ["bun test: 23 pass"],
    ),
  );
  await submit(
    makeSignal(runId, "ANCHOR_RECORDED", "tool", "verifier", { anchor: "frozen-set-intact", status: "passed" }, [
      `frozen set intact: ${contract.modelHash}`,
    ]),
  );
  await submit(
    makeSignal(runId, "ANCHOR_RECORDED", "tool", "verifier", { anchor: "regression", status: "passed" }, [
      "regression suite green",
    ]),
  );
  await submit(
    makeSignal(runId, "ANCHOR_RECORDED", "tool", "verifier", { anchor: "rollback-path-exists", status: "passed" }, [
      `rollback artifact verified: ${baseDraft.rollbackArtifact}`,
    ]),
  );
  await submit(makeSignal(runId, "VERIFY_EVALUATE", "system", "product-runner"));
};

const recordSample = (runId: string, metric: "errors" | "aiCost" | "latency", exceeded: boolean, evidence: string) =>
  makeSignal(
    runId,
    "OBSERVATION_SAMPLE",
    "tool",
    "observation-gate",
    { sample: { metric, value: exceeded ? 5 : 0, threshold: exceeded ? 1 : 10, exceeded, evidence } },
    [evidence],
  );

// Scenario 1 — nominal: three clean samples across the window validate the run.
const nominal: ScenarioDrive = async ({ submit, evaluateObservation, runId }) => {
  await driveToObservation(submit, runId);
  await submit(recordSample(runId, "errors", false, "no errors in window"));
  await submit(recordSample(runId, "aiCost", false, "ai cost within budget"));
  await submit(recordSample(runId, "latency", false, "latency within budget"));
  await evaluateObservation();
};

// Scenario 2 — a single degraded sample never rolls back. With fewer than N
// samples the window cannot validate either, so OBSERVATION_EVALUATE HOLDS and
// the run stays under observation. This is the model's core safety guarantee.
const singleDegraded: ScenarioDrive = async ({ submit, evaluateObservation, runId }) => {
  await driveToObservation(submit, runId);
  await submit(recordSample(runId, "errors", true, "transient error spike"));
  await evaluateObservation();
};

// Scenario 3 — three consecutive threshold-breaching samples confirm degradation:
// observation → rollback, then the rollback-opener opens a corrective proposition.
const consecutiveDegraded: ScenarioDrive = async ({ submit, evaluateObservation, runId }) => {
  await driveToObservation(submit, runId);
  for (let i = 0; i < 3; i += 1) {
    await submit(recordSample(runId, "errors", true, `sustained error surge #${i + 1}`));
  }
  await evaluateObservation();
  await submit(makeSignal(runId, "CORRECTIVE_PROPOSITION_OPENED", "tool", "rollback-opener"));
};

const results: ScenarioResult[] = [];
for (const [name, expected, drive] of [
  ["nominal", "validated", nominal],
  ["single-degraded", "observation", singleDegraded],
  ["consecutive-degraded", "proposition", consecutiveDegraded],
] as const) {
  results.push(await runScenario(name, expected, drive));
}

process.stdout.write(`${JSON.stringify({ modelHash: contract.modelHash, scenarios: results }, null, 2)}\n`);

if (results.some((result) => !result.passed)) process.exitCode = 1;
