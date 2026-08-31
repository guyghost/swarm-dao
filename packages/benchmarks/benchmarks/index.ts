#!/usr/bin/env bun
import { promises as fs } from "node:fs";
import path from "node:path";
import { type BenchmarkSuite, formatReport, runSuites } from "../src/harness.js";
import { artefactsSuite } from "./artefacts.benchmark.js";
import { calibrationSuite } from "./calibration.benchmark.js";
import { deliberationSuite } from "./deliberation.benchmark.js";
import { persistenceSuite } from "./persistence.benchmark.js";

export const SUITES: BenchmarkSuite[] = [calibrationSuite, deliberationSuite, persistenceSuite, artefactsSuite];

interface CliOptions {
  json?: string;
  iterations?: number;
  filter?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--json" && value) {
      options.json = value;
      index++;
    } else if (arg === "--iterations" && value) {
      options.iterations = Number(value);
      index++;
    } else if (arg === "--filter" && value) {
      options.filter = value;
      index++;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const suites = options.filter ? SUITES.filter((suite) => suite.name.includes(options.filter ?? "")) : SUITES;
  if (suites.length === 0) throw new Error(`No benchmark suite matches "${options.filter}"`);

  const report = await runSuites(suites, { iterations: options.iterations });
  console.log(formatReport(report));

  if (options.json) {
    await fs.mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    await fs.writeFile(path.resolve(options.json), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nWrote ${options.json}`);
  }
}

if (import.meta.main) {
  await main();
}
