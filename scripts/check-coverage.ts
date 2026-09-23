#!/usr/bin/env bun
// Swarm DAO — coverage gate (scripts/check-coverage.ts).
//
// Parses coverage/lcov.info (produced by `bun test --coverage`, see bunfig)
// and enforces explicit line/function thresholds. Why not bunfig's
// coverageThreshold: bun 1.4.2 enforces statement and branch metrics that its
// own lcov output does not emit, so every threshold form (scalar or table)
// fails opaquely regardless of the measured line/function numbers (reproduced
// 2026-09-20: scalar 0.65 exits 1 while lcov reports 66.02% lines / 74.55%
// functions). This script makes the gate visible and tunable instead.
//
// Usage: bun scripts/check-coverage.ts   (after `bun test --coverage`)

import { readFile } from "node:fs/promises";

const LINES_THRESHOLD = 0.65; // baseline 66.02% (2026-09-20) minus ~1pt
const FUNCTIONS_THRESHOLD = 0.72; // baseline 74.55% (2026-09-20) minus ~2pt

/** Per package, under the 2026-09-22 Ubuntu CI lcov (bun 1.4.0).
 *  A package can no longer regress inside a healthy workspace total.
 *  herdr-adapter is lower than a local mac run: several adapter branches
 *  stay uncovered on the Linux runner.
 *  pi/opencode floors measure `src/` (tests import `../src/index.ts`);
 *  raised from the previous dist-blind 8% / missing floors once src was visible. */
const PACKAGE_FLOORS: Record<string, { lines: number; functions: number }> = {
  "packages/core": { lines: 0.64, functions: 0.66 },
  "packages/cli": { lines: 0.56, functions: 0.66 },
  "packages/mcp-server": { lines: 0.39, functions: 0.58 },
  "packages/pi-adapter": { lines: 0.7, functions: 0.7 },
  "packages/opencode-adapter": { lines: 0.56, functions: 0.4 },
  "packages/improvement-loop": { lines: 0.86, functions: 0.88 },
  "packages/graph-engineering": { lines: 0.88, functions: 0.94 },
  "packages/product-loop": { lines: 0.84, functions: 0.9 },
  "packages/herdr-adapter": { lines: 0.88, functions: 0.76 },
  "packages/tmux-adapter": { lines: 0.96, functions: 0.84 },
  "packages/claude-adapter": { lines: 0.9, functions: 0.9 },
  "packages/codex-adapter": { lines: 0.9, functions: 0.9 },
  "packages/copilot-adapter": { lines: 0.9, functions: 0.9 },
};

interface Totals {
  linesHit: number;
  linesFound: number;
  functionsHit: number;
  functionsFound: number;
}

function emptyTotals(): Totals {
  return { linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0 };
}

function add(target: Totals, key: "LH" | "LF" | "FNH" | "FNF", value: number): void {
  if (key === "LH") target.linesHit += value;
  else if (key === "LF") target.linesFound += value;
  else if (key === "FNH") target.functionsHit += value;
  else target.functionsFound += value;
}

async function parseLcov(filePath: string): Promise<{ totals: Totals; packages: Map<string, Totals> }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    console.error(
      `check:coverage — ${filePath} not found. Run \`bun test --coverage\` first (see the test:coverage script).`,
    );
    process.exit(1);
  }
  const totals = emptyTotals();
  const packages = new Map<string, Totals>();
  let current = "other";
  const bucket = (name: string): Totals => {
    let found = packages.get(name);
    if (!found) {
      found = emptyTotals();
      packages.set(name, found);
    }
    return found;
  };
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const rest = line.slice(colon + 1);
    if (key === "SF") {
      const normalized = rest.replaceAll("\\", "/");
      const match = normalized.match(/packages\/[^/]+/);
      current = match ? match[0] : "other";
      continue;
    }
    const value = Number.parseInt(rest, 10);
    if (Number.isNaN(value)) continue;
    if (key === "LH" || key === "LF" || key === "FNH" || key === "FNF") {
      add(totals, key, value);
      add(bucket(current), key, value);
    }
  }
  return { totals, packages };
}

const pct = (hit: number, found: number): number => (found === 0 ? 100 : (100 * hit) / found);
const fails = (hit: number, found: number, threshold: number): boolean => found > 0 && hit / found < threshold;

const { totals, packages } = await parseLcov("coverage/lcov.info");
const linesPct = pct(totals.linesHit, totals.linesFound);
const functionsPct = pct(totals.functionsHit, totals.functionsFound);

console.log(
  `check:coverage — lines ${totals.linesHit}/${totals.linesFound} (${linesPct.toFixed(2)}%), ` +
    `functions ${totals.functionsHit}/${totals.functionsFound} (${functionsPct.toFixed(2)}%)`,
);
console.log(
  `check:coverage — thresholds: lines ≥ ${(LINES_THRESHOLD * 100).toFixed(0)}%, functions ≥ ${(FUNCTIONS_THRESHOLD * 100).toFixed(0)}%`,
);

const failures: string[] = [];
if (fails(totals.linesHit, totals.linesFound, LINES_THRESHOLD)) {
  failures.push(`line coverage ${linesPct.toFixed(2)}% is below ${(LINES_THRESHOLD * 100).toFixed(0)}%`);
}
if (fails(totals.functionsHit, totals.functionsFound, FUNCTIONS_THRESHOLD)) {
  failures.push(`function coverage ${functionsPct.toFixed(2)}% is below ${(FUNCTIONS_THRESHOLD * 100).toFixed(0)}%`);
}

for (const [name, floor] of Object.entries(PACKAGE_FLOORS)) {
  const measured = packages.get(name);
  if (!measured || measured.linesFound === 0) {
    failures.push(`${name} has no line coverage in lcov`);
    continue;
  }
  const pkgLines = pct(measured.linesHit, measured.linesFound);
  const pkgFns = pct(measured.functionsHit, measured.functionsFound);
  console.log(
    `check:coverage — ${name} lines ${pkgLines.toFixed(2)}%, functions ${pkgFns.toFixed(2)}% ` +
      `(floors ${(floor.lines * 100).toFixed(0)}% / ${(floor.functions * 100).toFixed(0)}%)`,
  );
  if (fails(measured.linesHit, measured.linesFound, floor.lines)) {
    failures.push(`${name} line coverage ${pkgLines.toFixed(2)}% is below ${(floor.lines * 100).toFixed(0)}%`);
  }
  if (fails(measured.functionsHit, measured.functionsFound, floor.functions)) {
    failures.push(`${name} function coverage ${pkgFns.toFixed(2)}% is below ${(floor.functions * 100).toFixed(0)}%`);
  }
}

if (failures.length > 0) {
  console.error(`check:coverage — FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("check:coverage — OK");
