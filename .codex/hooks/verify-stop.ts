import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateGraphContract } from "../../tools/graph-engineering/contract.js";
import { evaluateStopGate } from "../../tools/graph-engineering/stop-gate.js";

const readJsonOrNull = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

const main = async (): Promise<void> => {
  for await (const _chunk of process.stdin) {
    // Consume the hook payload. Decisions use only deterministic repository state.
  }

  const root = process.cwd();
  const contract = await validateGraphContract(root);
  if (!contract.valid) {
    process.stdout.write(
      `${JSON.stringify({
        continue: false,
        stopReason: `graph contract invalid: ${contract.issues.join("; ")}`,
        systemMessage: "Graph Engineering contract validation failed.",
      })}\n`,
    );
    return;
  }

  const evidenceRoot = resolve(root, "evidence/graph-runs");
  const active = await readJsonOrNull(resolve(evidenceRoot, "active-run.json"));
  if (!active || typeof active !== "object" || !("runId" in active) || typeof active.runId !== "string") {
    process.stdout.write(`${JSON.stringify(evaluateStopGate(null))}\n`);
    return;
  }

  const snapshot = await readJsonOrNull(resolve(evidenceRoot, active.runId, "snapshot.json"));
  process.stdout.write(`${JSON.stringify(evaluateStopGate(snapshot))}\n`);
};

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      continue: false,
      stopReason: `graph stop gate failed closed: ${error instanceof Error ? error.message : String(error)}`,
      systemMessage: "Graph Engineering stop gate failed closed.",
    })}\n`,
  );
});
