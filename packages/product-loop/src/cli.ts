// Swarm DAO — Product loop run CLI.
//
// Thin host entry over ProductRunner: init/status/submit with the same
// exit-code contract as the graph and improvement CLIs (0 success, 2 machine
// rejection, 1 usage or execution error). Hosts stay free of transition
// rules — every submitted signal passes through validateProductSignal and the
// frozen product-loop machine.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createProductRunner } from "./runner.js";

export interface ProductCliDefaults {
  /** Evidence root used when --evidence-root is absent (resolved from cwd). */
  evidenceRoot?: string;
}

const usage = `Usage:
  product <init|status|submit> --run-id <id> [--evidence-root <path>]
  product submit --run-id <id> --signal <file> [--evidence-root <path>]`;

/**
 * Entry point for the `product:*` repo scripts and the swarm-dao CLI.
 * Exit codes: 0 success, 2 machine rejection, 1 usage or execution error.
 */
export const runProductCli = async (argv: readonly string[], defaults: ProductCliDefaults = {}): Promise<number> => {
  const command = argv[0];
  if (command !== "init" && command !== "status" && command !== "submit") throw new Error(usage);

  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    options: {
      "run-id": { type: "string" },
      "evidence-root": { type: "string" },
      signal: { type: "string" },
    },
  });
  const runId = values["run-id"];
  if (!runId) throw new Error(`--run-id is required\n${usage}`);

  const evidenceRoot = resolve(values["evidence-root"] ?? defaults.evidenceRoot ?? ".dao/product-loops");
  if (command === "submit" && !values.signal) throw new Error(`--signal is required\n${usage}`);
  const runner = await createProductRunner({ evidenceRoot, runId });

  if (command === "init" || command === "status") {
    process.stdout.write(`${JSON.stringify(runner.snapshot(), null, 2)}\n`);
    return 0;
  }

  const signal = JSON.parse(await readFile(resolve(values.signal as string), "utf8"));
  const result = await runner.submit(signal);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.accepted ? 0 : 2;
};
