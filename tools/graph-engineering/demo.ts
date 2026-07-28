import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REQUIRED_GRAPH_ANCHORS } from "../../packages/core/src/models/graph-engineering.machine.js";
import { validateGraphContract } from "./contract.js";
import { createGraphRunner } from "./runner.js";

type ApprovalRecord = Readonly<{
  modelHash: string;
  approvedAt: string;
  statement: string;
}>;

const root = process.cwd();
const evidenceRoot = resolve(root, "evidence/graph-runs");
const approvalPath = resolve(evidenceRoot, "model-approval.json");
const runId = `graph-demo-${Date.now()}`;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const implementationPaths = [
  "packages/core/src/models/graph-engineering.machine.ts",
  "tools/graph-engineering/signal.ts",
  "tools/graph-engineering/runner.ts",
  "tools/graph-engineering/contract.ts",
  "tools/graph-engineering/stop-gate.ts",
  "tools/graph-engineering/graphctl.ts",
  ".agents/skills/graph-engineering/SKILL.md",
  ".codex/hooks.json",
  ".codex/hooks/verify-stop.ts",
] as const;

const hashImplementation = async (): Promise<string> => {
  let manifest = "";
  for (const relativePath of implementationPaths) {
    manifest += `${sha256(await readFile(resolve(root, relativePath)))}  ${relativePath}\n`;
  }
  return sha256(manifest);
};

const contract = await validateGraphContract(root);
if (!contract.valid) throw new Error(`graph contract invalid: ${contract.issues.join("; ")}`);

let approval: ApprovalRecord;
try {
  approval = JSON.parse(await readFile(approvalPath, "utf8"));
} catch (error) {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    throw new Error(`missing explicit approval record at ${approvalPath}`);
  }
  throw error;
}
if (
  approval.modelHash !== contract.modelHash ||
  typeof approval.approvedAt !== "string" ||
  Number.isNaN(Date.parse(approval.approvedAt)) ||
  approval.statement !== `J’approuve le modèle ${contract.modelHash}`
) {
  throw new Error("approval record is invalid or does not match the current model hash");
}

const runner = await createGraphRunner({ evidenceRoot, runId });
await writeFile(resolve(evidenceRoot, "active-run.json"), `${JSON.stringify({ runId }, null, 2)}\n`, "utf8");

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

const submitRequired = async (signal: unknown): Promise<void> => {
  const result = await runner.submit(signal);
  if (!result.accepted) throw new Error(`reference scenario event rejected: ${result.issues.join("; ")}`);
};

await submitRequired(
  makeSignal("MODEL_DRAFTED", "ai", "modeler", { modelHash: contract.modelHash }, [
    "model hash computed from the approved ordered manifest",
  ]),
);
await submitRequired(
  makeSignal("MODEL_CONTRACT_VALID", "tool", "model-contract-validator", {}, [
    `graph contract valid for ${contract.modelHash}`,
  ]),
);
await submitRequired(
  makeSignal("MODEL_APPROVED", "human", "human-owner", { modelHash: approval.modelHash }, [approval.statement]),
);
await submitRequired(makeSignal("START_IMPLEMENTATION", "system", "graph-runner"));

const implementationHash = await hashImplementation();
await submitRequired(
  makeSignal("IMPLEMENTATION_READY", "ai", "implementer", { implementationHash }, [
    "reference implementation manifest hashed",
  ]),
);

for (const anchor of REQUIRED_GRAPH_ANCHORS.filter((name) => name !== "model-contract")) {
  const producer =
    anchor === "architecture-contract"
      ? "architecture-watcher"
      : anchor === "regression"
        ? "regression-watcher"
        : "runtime-verifier";
  await submitRequired(
    makeSignal("ANCHOR_RECORDED", "tool", producer, { anchor, status: "passed" }, [
      `reference scenario exercised ${anchor} event routing`,
    ]),
  );
}
await submitRequired(makeSignal("EVALUATE", "system", "graph-runner"));

const snapshot = runner.snapshot();
process.stdout.write(
  `${JSON.stringify(
    {
      runId,
      state: snapshot.state,
      modelHash: contract.modelHash,
      implementationHash,
      anchors: snapshot.context.anchors,
      evidenceDirectory: resolve(evidenceRoot, runId),
    },
    null,
    2,
  )}\n`,
);
if (snapshot.state !== "succeeded") process.exitCode = 1;
