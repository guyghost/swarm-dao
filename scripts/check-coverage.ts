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

interface Totals {
  linesHit: number;
  linesFound: number;
  functionsHit: number;
  functionsFound: number;
}

async function parseLcov(path: string): Promise<Totals> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    console.error(
      `check:coverage — ${path} not found. Run \`bun test --coverage\` first (see the test:coverage script).`,
    );
    process.exit(1);
  }
  const totals: Totals = { linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0 };
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const value = Number.parseInt(line.slice(colon + 1), 10);
    if (Number.isNaN(value)) continue;
    if (key === "LH") totals.linesHit += value;
    else if (key === "LF") totals.linesFound += value;
    else if (key === "FNH") totals.functionsHit += value;
    else if (key === "FNF") totals.functionsFound += value;
  }
  return totals;
}

const pct = (hit: number, found: number): number => (found === 0 ? 100 : (100 * hit) / found);
const fails = (hit: number, found: number, threshold: number): boolean => found > 0 && hit / found < threshold;

const totals = await parseLcov("coverage/lcov.info");
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

if (failures.length > 0) {
  console.error(`check:coverage — FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("check:coverage — OK");
