import { spawn } from "node:child_process";
import { validateProductContract } from "./contract.js";

/**
 * Anchor-reality gate for the product loop. Verifies that the declared product
 * anchors are pinned to the reviewed model (deterministic contract) AND that
 * the regression suite honors the authority boundary (the AI cannot drive state,
 * forge anchors, cancel, resolve reviews, or authorize a contact relay).
 *
 * This is the command bound to the `anchor-reality` anchor in
 * models/product-loop.graph.json. It deliberately does NOT invoke the other
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
    let settled = false;
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    // spawn() can fail to start (ENOENT etc.) and emit "error" instead of
    // "close"; without this handler the gate would hang forever on that path.
    child.on("error", (error) =>
      finish({ code: null, signal: null, stdout, stderr: stderr ? `${stderr}\n${error.message}` : error.message }),
    );
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr }));
  });

const main = async (): Promise<void> => {
  const root = process.cwd();
  const contract = await validateProductContract(root);
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

  const regression = await run("bun", ["test", "packages/core/tests/product-loop.regression.test.ts"]);
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
