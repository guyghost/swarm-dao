import { spawn } from "node:child_process";
import { validateImprovementContract } from "./contract.js";

/**
 * Anchor-reality gate. Verifies that the declared improvement anchors are pinned
 * to the reviewed model (deterministic contract) AND that the implementation
 * honors the authority boundary (the regression suite asserts the AI cannot
 * drive state, self-approve references, or unfreeze the frozen set).
 *
 * This is the command bound to the `anchor-reality` anchor in
 * models/improvement-loop.graph.json. It deliberately does NOT invoke the other
 * frozen anchor commands, so there is no recursion.
 */
const run = (
  cmd: string,
  args: readonly string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args as string[], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

const main = async (): Promise<void> => {
  const root = process.cwd();
  const contract = await validateImprovementContract(root);
  if (!contract.valid) {
    process.stdout.write(
      JSON.stringify(
        { anchor: "anchor-reality", passed: false, reason: "contract drifted", issues: contract.issues },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const regression = await run("bun", ["test", "packages/core/tests/improvement-loop.regression.test.ts"]);
  // A null exit code means the regression child was terminated by a signal
  // (e.g. OOM kill or external timeout). That is not a pass; only an explicit
  // exit code of 0 is.
  const passed = regression.code === 0;
  process.stdout.write(
    `${JSON.stringify(
      {
        anchor: "anchor-reality",
        passed,
        modelHash: contract.modelHash,
        regressionExitCode: regression.code,
        regressionSignal: regression.signal,
        regressionTail: regression.stdout.split("\n").filter(Boolean).slice(-3),
      },
      null,
      2,
    )}\n`,
  );
  if (!passed) process.exitCode = 1;
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
