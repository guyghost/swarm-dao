import { resolve } from "node:path";
import { validateProductContract } from "./contract.js";
import { createProductRunner } from "./runner.js";

const root = process.cwd();
const evidenceRoot = resolve(root, "evidence/product-loops");
const runId = `product-demo-${Date.now()}`;

const contract = await validateProductContract(root);
if (!contract.valid) throw new Error(`product contract invalid: ${contract.issues.join("; ")}`);

const runner = await createProductRunner({ evidenceRoot, runId });

const makeSignal = (
  type: string,
  source: "ai" | "tool" | "human" | "system",
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

const submit = async (signal: unknown): Promise<void> => {
  const result = await runner.submit(signal);
  if (!result.accepted) throw new Error(`reference scenario event rejected: ${result.issues.join("; ")}`);
};

// 1. Exploration → Proposition. An AI drafts a proposal; the deterministic
//    proposition-gate promotes the draft into a tracked proposition. The AI
//    never selects a target state — it only produces the draft.
await submit(
  makeSignal(
    "PROPOSAL_DRAFTED",
    "ai",
    "proposer",
    {
      draft: {
        scope: "demo: cache the rendered proposal digest to cut read latency",
        category: "performance",
        touchesSensitive: false,
        dependencies: ["packages/core/src/models/proposal.machine.ts"],
        budgetAllocation: 80,
        rollbackArtifact: "evidence/rollback/digest-cache-revert.patch",
        evidence: "benchmark: digest render 42ms → 9ms over 1000 reads",
      },
    },
    ["benchmark: digest render 42ms → 9ms over 1000 reads"],
  ),
);
await submit(makeSignal("OPEN_PROPOSITION", "tool", "proposition-gate"));

// 2. Proposition → Qualification → Vote. Qualification carries an affirmative,
//    evidence-backed permission clearance — it never passes on the mere absence
//    of a denial. The machine validates scope, category, dependencies, budget,
//    and explicit permission before sealing the qualification-passed anchor.
await submit(
  makeSignal(
    "QUALIFICATION_RUN",
    "tool",
    "qualifier",
    {
      permissionCleared: true,
      permissionEvidence: "permissions: none required (performance category, no sensitive data)",
    },
    ["permissions: none required (performance category, no sensitive data)"],
  ),
);

// 3. Vote. The vote-tally tool opens the vote with a quorum and records
//    favorable votes. The runner (system) then evaluates the quorum
//    deterministically — never an AI.
await submit(
  makeSignal("VOTE_OPENED", "tool", "vote-tally", { config: { quorum: 3, kind: "standard", expiryHours: 72 } }, [
    "vote opened: quorum 3, standard, 72h expiry",
  ]),
);
await submit(makeSignal("VOTE_CAST", "tool", "vote-tally", { favorable: 3 }, ["3 favorable votes recorded"]));
await submit(makeSignal("VOTE_EVALUATE", "system", "product-runner"));

// 4. Adopted → Execution. The machine auto-opens the shared task budget on
//    entry to execution; the budget-ledger tool charges against it.
await submit(
  makeSignal(
    "BUDGET_CHARGE",
    "tool",
    "budget-ledger",
    { action: { amount: 25, description: "implementation spend", evidence: "ledger: impl charge 25" } },
    ["ledger: impl charge 25"],
  ),
);
await submit(makeSignal("EXECUTION_DONE", "tool", "budget-ledger"));

// 5. Verification. The verifier records a passing control. The three external
//    anchors (frozen-set-intact, regression, rollback-path-exists) must be
//    recorded by the tool before the runner evaluates — they are never
//    auto-sealed by the machine. `rollback-path-exists` is a ship-gate
//    prerequisite: the verifier confirms the rollback artifact is genuine
//    before VERIFY_EVALUATE can pass the canShip guard.
await submit(
  makeSignal(
    "VERIFY_RUN",
    "tool",
    "verifier",
    { control: { name: "unit-tests", status: "passed", evidence: "bun test: 23 pass" } },
    ["bun test: 23 pass"],
  ),
);
await submit(
  makeSignal("ANCHOR_RECORDED", "tool", "verifier", { anchor: "frozen-set-intact", status: "passed" }, [
    `frozen set intact: ${contract.modelHash}`,
  ]),
);
await submit(
  makeSignal("ANCHOR_RECORDED", "tool", "verifier", { anchor: "regression", status: "passed" }, [
    "regression suite green",
  ]),
);
await submit(
  makeSignal(
    "ANCHOR_RECORDED",
    "tool",
    "verifier",
    { anchor: "rollback-path-exists", status: "passed" },
    ["rollback artifact confirmed genuine: evidence/rollback/digest-cache-revert.patch"],
  ),
);
await submit(makeSignal("VERIFY_EVALUATE", "system", "product-runner"));

// 6. Ship → Observation. Auto-ship is allowed only for reversible, allowed-
//    category improvements with a rollback path and remaining budget. The
//    observation-gate records non-degrading samples; the runner evaluates.
//    The observationClean guard requires ≥ 3 clean samples and windowElapsed.
await submit(
  makeSignal(
    "OBSERVATION_SAMPLE",
    "tool",
    "observation-gate",
    { sample: { metric: "errors", value: 0, threshold: 1, exceeded: false, evidence: "no errors in window" } },
    ["no errors in window"],
  ),
);
await submit(
  makeSignal(
    "OBSERVATION_SAMPLE",
    "tool",
    "observation-gate",
    { sample: { metric: "aiCost", value: 5, threshold: 20, exceeded: false, evidence: "ai cost within budget" } },
    ["ai cost within budget"],
  ),
);
await submit(
  makeSignal(
    "OBSERVATION_SAMPLE",
    "tool",
    "observation-gate",
    {
      sample: { metric: "latency", value: 8, threshold: 50, exceeded: false, evidence: "latency within threshold" },
    },
    ["latency within threshold"],
  ),
);
await submit(makeSignal("OBSERVATION_EVALUATE", "system", "product-runner", { windowElapsed: true }));

const snapshot = runner.snapshot();
process.stdout.write(
  `${JSON.stringify(
    {
      runId,
      state: snapshot.state,
      modelHash: contract.modelHash,
      budget: snapshot.context.budget,
      anchors: snapshot.context.anchors,
      controls: snapshot.context.controls,
      evidenceDirectory: resolve(evidenceRoot, runId),
    },
    null,
    2,
  )}\n`,
);
if (snapshot.state !== "validated") process.exitCode = 1;
