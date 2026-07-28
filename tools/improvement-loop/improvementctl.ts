#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createImprovementRunner } from "./runner.js";

const usage = `Usage:
  bun run improvement:init -- --cycle-id <id> --reference-hash <hash> [--scope <s>] [--evidence-root <path>]
  bun run improvement:status -- --cycle-id <id> [--evidence-root <path>]
  bun run improvement:submit -- --cycle-id <id> --signal <file> [--evidence-root <path>]`;

const main = async (): Promise<void> => {
  const command = process.argv[2];
  if (command !== "init" && command !== "status" && command !== "submit") throw new Error(usage);

  const { values } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      "cycle-id": { type: "string" },
      "reference-hash": { type: "string" },
      scope: { type: "string" },
      "evidence-root": { type: "string" },
      signal: { type: "string" },
    },
  });
  const cycleId = values["cycle-id"];
  if (!cycleId) throw new Error(`--cycle-id is required\n${usage}`);

  const evidenceRoot = resolve(values["evidence-root"] ?? "evidence/improvement-cycles");
  if (command === "submit" && !values.signal) throw new Error(`--signal is required\n${usage}`);

  let referenceHash = values["reference-hash"] ?? "";
  let scope = values.scope ?? "default";
  if (command === "init") {
    if (!referenceHash) throw new Error(`--reference-hash is required\n${usage}`);
  } else {
    // status/submit recover the reference hash AND scope from the persisted
    // snapshot so running without the original flags cannot mutate the stored
    // cycle identity.
    try {
      const snapshot = JSON.parse(await readFile(resolve(evidenceRoot, cycleId, "snapshot.json"), "utf8"));
      referenceHash = snapshot?.context?.referenceHash ?? "";
      scope = snapshot?.context?.scope ?? "default";
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw new Error(`cycle ${cycleId} has no snapshot; run improvement:init first`);
      }
      throw error;
    }
  }

  const runner = await createImprovementRunner({
    evidenceRoot,
    cycleId,
    scope,
    referenceHash,
  });

  if (command === "init") {
    await writeFile(resolve(evidenceRoot, "active-cycle.json"), `${JSON.stringify({ cycleId }, null, 2)}\n`, "utf8");
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
