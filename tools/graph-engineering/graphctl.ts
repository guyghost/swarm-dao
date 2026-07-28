#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createGraphRunner } from "./runner.js";

const usage = `Usage:
  bun run graph:init -- --run-id <id> [--evidence-root <path>]
  bun run graph:status -- --run-id <id> [--evidence-root <path>]
  bun run graph:submit -- --run-id <id> --signal <file> [--evidence-root <path>]`;

const main = async (): Promise<void> => {
  const command = process.argv[2];
  if (command !== "init" && command !== "status" && command !== "submit") throw new Error(usage);

  const { values } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      "run-id": { type: "string" },
      "evidence-root": { type: "string" },
      signal: { type: "string" },
    },
  });
  const runId = values["run-id"];
  if (!runId) throw new Error(`--run-id is required\n${usage}`);

  const evidenceRoot = resolve(values["evidence-root"] ?? "evidence/graph-runs");
  if (command === "submit" && !values.signal) throw new Error(`--signal is required\n${usage}`);
  const runner = await createGraphRunner({ evidenceRoot, runId });

  if (command === "init") {
    await writeFile(resolve(evidenceRoot, "active-run.json"), `${JSON.stringify({ runId }, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(runner.snapshot(), null, 2)}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(runner.snapshot(), null, 2)}\n`);
    return;
  }

  const signal = JSON.parse(await readFile(resolve(values.signal as string), "utf8"));
  const result = await runner.submit(signal);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.accepted) process.exitCode = 2;
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
