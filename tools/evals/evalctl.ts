#!/usr/bin/env bun
// ============================================================
// Swarm DAO — Eval control (list | run | compare)
// ============================================================
// Replays the eval suite (models/README.md anchor tables plus the
// architecture/docs gates) into a scorecard, and diffs candidate
// scorecards against a reference. The model-adoption loop:
//
//   bun run evals:run --label baseline
//   # ... bind a candidate harness/model in .dao/config.json ...
//   bun run evals:run --label candidate
//   bun run evals:compare --base evidence/evals/baseline.json \
//     --candidate evidence/evals/candidate.json
//
// Deterministic battery: no LLM calls. Live-model scenario runs are
// a deferred layer that will emit scorecards in the same shape.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HARNESS_MODEL_FLAGS } from "../../packages/core/src/intelligence/runtime.js";
import { extractLastJsonObject, runHerdrWorker, SAFE_HERDR_KIND } from "../../packages/improvement-loop/src/workers.js";
import { compareScorecards, hasRegressions } from "./compare.js";
import { gradeAnswer, SCENARIOS, type Scenario } from "./scenarios.js";
import { EVAL_SUITE, type EvalResult, type Scorecard } from "./suite.js";

const ROOT = path.resolve(import.meta.dir, "../..");
const DEFAULT_EVIDENCE_DIR = path.join(ROOT, "evidence", "evals");
const STDERR_TAIL_LINES = 15;

const usage = `Usage:
  bun tools/evals/evalctl.ts list
  bun tools/evals/evalctl.ts run --label <id> [--filter <id-prefix>] [--json <path>]
  bun tools/evals/evalctl.ts scenario --label <id> [--scenario <id>] [--kind <herdr-kind>] [--model <model>] [--timeout <ms>] [--json <path>]
  bun tools/evals/evalctl.ts compare --base <path> --candidate <path>`;

const argv = process.argv.slice(2);
const subcommand = argv[0];
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? undefined) : undefined;
};

// ── list ─────────────────────────────────────────────────────

function list(): void {
  const idWidth = Math.max(...EVAL_SUITE.map((entry) => entry.id.length));
  for (const entry of EVAL_SUITE) {
    const anchors = entry.anchors?.length ? ` [${entry.anchors.join(", ")}]` : "";
    console.log(`${entry.id.padEnd(idWidth)}  ${entry.area.padEnd(19)} ${entry.command}${anchors}`);
  }
  console.log(`\n${EVAL_SUITE.length} evals. Run all: bun run evals:run --label <id>`);
}

// ── run ──────────────────────────────────────────────────────

function runOne(command: string): Promise<EvalResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      "bun",
      command.split(" ").slice(1),
      { cwd: ROOT, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const exitCode = typeof error?.code === "number" ? error.code : error ? null : 0;
        const stderrText = exitCode === 0 || typeof stderr !== "string" || !stderr.trim() ? undefined : stderr;
        resolve({
          id: command,
          command,
          status: exitCode === 0 ? "passed" : "failed",
          exitCode,
          durationMs,
          stderrTail: stderrText ? stderrText.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n") : undefined,
        });
      },
    );
  });
}

async function run(): Promise<number> {
  const label = arg("label");
  if (!label || !/^[a-z0-9][a-z0-9._-]*$/i.test(label)) {
    console.error(`run requires --label <id> (alphanumeric, . _ -)\n${usage}`);
    return 2;
  }
  const filter = arg("filter");
  const entries = EVAL_SUITE.filter((entry) => !filter || entry.id.startsWith(filter));
  if (entries.length === 0) {
    console.error(`no evals match filter "${filter}"`);
    return 2;
  }

  console.log(`evals:run — ${entries.length} eval(s), label "${label}"\n`);
  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];
  for (const entry of entries) {
    const result = await runOne(entry.command);
    results.push({ ...result, id: entry.id });
    const mark = result.status === "passed" ? "PASS" : "FAIL";
    console.log(`${mark}  ${entry.id} (${result.durationMs}ms)  ${entry.command}`);
    if (result.stderrTail) console.error(result.stderrTail);
  }
  const finishedAt = new Date().toISOString();

  const passed = results.filter((result) => result.status === "passed").length;
  const scorecard: Scorecard = {
    label,
    startedAt,
    finishedAt,
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      totalMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    },
  };

  const outPath = arg("json") ?? path.join(DEFAULT_EVIDENCE_DIR, `${label}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  console.log(
    `\nsummary: ${passed}/${results.length} passed in ${scorecard.summary.totalMs}ms — scorecard: ${path.relative(ROOT, outPath)}`,
  );
  return scorecard.summary.failed > 0 ? 1 : 0;
}

// ── compare ──────────────────────────────────────────────────

function readScorecard(name: string, filePath: string | undefined): Scorecard {
  if (!filePath) {
    console.error(`compare requires --${name} <path>\n${usage}`);
    process.exit(2);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Scorecard;
  if (!Array.isArray(parsed.results) || typeof parsed.summary?.totalMs !== "number") {
    console.error(`${filePath} is not an eval scorecard`);
    process.exit(2);
  }
  return parsed;
}

function compare(): number {
  const base = readScorecard("base", arg("base"));
  const candidate = readScorecard("candidate", arg("candidate"));
  const diff = compareScorecards(base, candidate);

  console.log(`evals:compare — base "${base.label}" vs candidate "${candidate.label}"\n`);
  for (const regression of diff.regressions) {
    console.error(`REGRESSION  ${regression.id} — passed on base, failed on candidate`);
    if (regression.stderrTail) console.error(regression.stderrTail);
  }
  for (const improvement of diff.improvements) console.log(`improved    ${improvement.id}`);
  for (const id of diff.added) console.log(`added       ${id} (not on base)`);
  for (const id of diff.removed) console.log(`removed     ${id} (missing on candidate)`);
  console.log(
    `\nsummary: ${diff.regressions.length} regression(s), ${diff.improvements.length} improvement(s), ${diff.durationDeltaMs >= 0 ? "+" : ""}${diff.durationDeltaMs}ms total`,
  );
  return hasRegressions(diff) ? 1 : 0;
}

// ── scenario (live, herdr) ─────────────────────────────

function scenarioResult(
  scenario: Scenario,
  rubricId: string,
  passed: boolean,
  durationMs: number,
  detail: string,
): EvalResult {
  return {
    id: `${scenario.id}.${rubricId}`,
    command: `evals:scenario ${scenario.id}`,
    status: passed ? "passed" : "failed",
    exitCode: passed ? 0 : 1,
    durationMs,
    stderrTail: passed ? undefined : detail,
  };
}

async function scenario(): Promise<number> {
  const label = arg("label");
  if (!label || !/^[a-z0-9][a-z0-9._-]*$/i.test(label)) {
    console.error(`scenario requires --label <id> (alphanumeric, . _ -)\n${usage}`);
    return 2;
  }
  const kind = arg("kind") ?? "pi";
  if (!SAFE_HERDR_KIND.test(kind)) {
    console.error(`--kind "${kind}" is not a valid herdr kind identifier`);
    return 2;
  }
  const model = arg("model");
  const modelFlag = HARNESS_MODEL_FLAGS[kind];
  if (model && modelFlag === undefined) {
    console.error(
      `--model is not supported for kind "${kind}" (known: ${Object.keys(HARNESS_MODEL_FLAGS).join(", ")})`,
    );
    return 2;
  }
  const filter = arg("scenario");
  const selected = SCENARIOS.filter((scenario) => !filter || scenario.id === filter);
  if (selected.length === 0) {
    console.error(`no scenario matches "${filter ?? ""}" (known: ${SCENARIOS.map((s) => s.id).join(", ")})`);
    return 2;
  }
  const timeoutMs = Number(arg("timeout") ?? 180_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    console.error("--timeout must be an integer between 1000 and 900000");
    return 2;
  }

  const agentArgs = model && modelFlag ? [modelFlag, model] : undefined;
  const dispatchDesc = `herdr/${kind}${model ? ` ${modelFlag} ${model}` : ""}`;
  console.log(`evals:scenario — ${selected.length} scenario(s) via ${dispatchDesc}, label "${label}"\n`);
  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];

  for (const scenario of selected) {
    const scenarioStart = Date.now();
    const harvest = await runHerdrWorker(
      {
        workDir: ROOT,
        kind,
        agentArgs,
        timeoutMs,
        // Eval answers are single JSON objects; prose settling is a failure,
        // so fail fast instead of the improvement workers' 3-minute window.
        stablePolls: 3,
      },
      `eval-${label}-${scenario.id}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32),
      scenario.prompt,
    );
    const durationMs = Date.now() - scenarioStart;
    if (!harvest.ok) {
      console.log(`FAIL  ${scenario.id}.dispatch (${durationMs}ms)`);
      console.error(harvest.error);
      results.push(scenarioResult(scenario, "dispatch", false, durationMs, harvest.error));
      continue;
    }
    const answer = extractLastJsonObject(harvest.content);
    for (const rubricResult of gradeAnswer(scenario, answer)) {
      const mark = rubricResult.passed ? "PASS" : "FAIL";
      console.log(`${mark}  ${rubricResult.id} (${durationMs}ms)  ${rubricResult.detail}`);
      results.push(scenarioResult(scenario, rubricResult.id, rubricResult.passed, durationMs, rubricResult.detail));
    }
  }
  const finishedAt = new Date().toISOString();

  const passed = results.filter((result) => result.status === "passed").length;
  const scorecard: Scorecard = {
    label,
    startedAt,
    finishedAt,
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      totalMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    },
  };

  const outPath = arg("json") ?? path.join(DEFAULT_EVIDENCE_DIR, `${label}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  console.log(
    `\nsummary: ${passed}/${results.length} passed in ${scorecard.summary.totalMs}ms — scorecard: ${path.relative(ROOT, outPath)}`,
  );
  return scorecard.summary.failed > 0 ? 1 : 0;
}

// ── Dispatch ─────────────────────────────────────────────────

switch (subcommand) {
  case "list":
    list();
    break;
  case "run":
    process.exit(await run());
    break;
  case "scenario":
    process.exit(await scenario());
    break;
  case "compare":
    process.exit(compare());
    break;
  default:
    console.error(usage);
    process.exit(subcommand === undefined ? 0 : 2);
}
