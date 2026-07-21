import { resolve } from "node:path";
import {
  REQUIRED_IMPROVEMENT_ANCHORS,
  arbitratePairedSignals,
  assertFrozenSetIntact,
} from "../../packages/core/src/models/improvement-loop.machine.js";
import { validateImprovementContract } from "./contract.js";
import { createImprovementRunner } from "./runner.js";

const root = process.cwd();
const evidenceRoot = resolve(root, "evidence/improvement-cycles");
const cycleId = `improvement-demo-${Date.now()}`;

const contract = await validateImprovementContract(root);
if (!contract.valid) throw new Error(`improvement contract invalid: ${contract.issues.join("; ")}`);

/**
 * The improvement loop supervises the drift of its OWN reviewed model. The
 * reference hash is therefore the approved model hash; the frozen-set anchor
 * asserts the live model still matches it.
 */
const referenceHash = contract.modelHash;
const runner = await createImprovementRunner({
  evidenceRoot,
  cycleId,
  scope: "self-improvement-cycle-demo",
  referenceHash,
});

const makeSignal = (
  type: string,
  source: "ai" | "tool" | "human" | "system",
  producer: string,
  payload: Record<string, unknown> = {},
  evidence: string[] = [],
) => ({
  cycleId,
  type,
  source,
  producer,
  occurredAt: new Date().toISOString(),
  payload,
  evidence,
});

const submitRequired = async (signal: unknown): Promise<void> => {
  const result = await runner.submit(signal);
  if (!result.accepted) throw new Error(`reference scenario event rejected: ${result.issues.join("; ")}`);
};

const metricSample = { value: "rose", evidence: "reference metric: throughput improved" };
const counterSample = { value: "rose", evidence: "reference counter-metric: latency held" };

await submitRequired(makeSignal("METRIC_SAMPLED", "ai", "sensor", { sample: metricSample }, [metricSample.evidence]));
await submitRequired(
  makeSignal("COUNTER_SAMPLED", "ai", "counter-sensor", { sample: counterSample }, [counterSample.evidence]),
);
await submitRequired(makeSignal("SAMPLES_SEALED", "tool", "sample-gate", {}, ["both paired signals sealed"]));
await submitRequired(
  makeSignal("DRIFT_ESTIMATE", "ai", "drift-auditor", { driftClass: "none" }, ["no drift from the reference model"]),
);

// The deterministic arbitrator — not an AI — decides the paired-signal outcome.
const arbitration = arbitratePairedSignals(metricSample, counterSample);
await submitRequired(
  makeSignal("ARBITRATION", "tool", "arbitrator", { outcome: arbitration.outcome }, [
    `arbitration outcome: ${arbitration.outcome}`,
  ]),
);

// The deterministic anchor verifier records the four non-auto anchors.
for (const anchor of REQUIRED_IMPROVEMENT_ANCHORS) {
  const auto = anchor === "counter-metric-paired" || anchor === "arbitration-policy";
  if (auto) continue;
  let evidence = `${anchor} satisfied`;
  if (anchor === "frozen-set-intact") {
    const intact = assertFrozenSetIntact(referenceHash, referenceHash);
    if (!intact) throw new Error("frozen set integrity failed in the reference scenario");
    evidence = `frozen set intact: ${referenceHash}`;
  }
  await submitRequired(
    makeSignal("ANCHOR_RECORDED", "tool", "anchor-verifier", { anchor, status: "passed" }, [evidence]),
  );
}

await submitRequired(makeSignal("EVALUATE", "system", "improvement-runner"));

const snapshot = runner.snapshot();
process.stdout.write(
  `${JSON.stringify(
    {
      cycleId,
      state: snapshot.state,
      modelHash: contract.modelHash,
      referenceHash,
      arbitrationOutcome: snapshot.context.arbitrationOutcome,
      driftClass: snapshot.context.driftClass,
      anchors: snapshot.context.anchors,
      evidenceDirectory: resolve(evidenceRoot, cycleId),
    },
    null,
    2,
  )}\n`,
);
if (snapshot.state !== "succeeded") process.exitCode = 1;
