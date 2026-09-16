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

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HARNESS_MODEL_FLAGS } from "../../packages/core/src/intelligence/runtime.js";
import { extractLastJsonObject, runHerdrWorker, SAFE_HERDR_KIND } from "../../packages/improvement-loop/src/workers.js";
import { compareScorecards, hasRegressions } from "./compare.js";
import { buildReviewPrompt, gradeReviewAnswer } from "./review.js";
import { gradeAnswer, SCENARIOS, type Scenario } from "./scenarios.js";
import { EVAL_SUITE, type EvalResult, type Scorecard } from "./suite.js";

const ROOT = path.resolve(import.meta.dir, "../..");
const DEFAULT_EVIDENCE_DIR = path.join(ROOT, "evidence", "evals");
const STDERR_TAIL_LINES = 15;

const usage = `Usage:
  bun tools/evals/evalctl.ts list
  bun tools/evals/evalctl.ts run --label <id> [--filter <id-prefix>] [--json <path>]
  bun tools/evals/evalctl.ts scenario --label <id> [--scenario <id>] [--kind <herdr-kind>] [--model <model>] [--timeout <ms>] [--json <path>]
  bun tools/evals/evalctl.ts review [--base <ref>] [--label <id>] [--kind <herdr-kind>] [--model <model>] [--json <path>]
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

function runOne(command: string, cwd: string = ROOT): Promise<EvalResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      "bun",
      command.split(" ").slice(1),
      { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
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

async function runBattery(filter: string | undefined, cwd: string, logPrefix = ""): Promise<EvalResult[]> {
  const entries = EVAL_SUITE.filter((entry) => !filter || entry.id.startsWith(filter));
  if (entries.length === 0) throw new Error(`no evals match filter "${filter}"`);
  const results: EvalResult[] = [];
  for (const entry of entries) {
    const result = await runOne(entry.command, cwd);
    results.push({ ...result, id: entry.id });
    const mark = result.status === "passed" ? "PASS" : "FAIL";
    console.log(`${logPrefix}${mark}  ${entry.id} (${result.durationMs}ms)  ${entry.command}`);
    if (result.stderrTail) console.error(result.stderrTail);
  }
  return results;
}

async function run(): Promise<number> {
  const label = arg("label");
  if (!label || !/^[a-z0-9][a-z0-9._-]*$/i.test(label)) {
    console.error(`run requires --label <id> (alphanumeric, . _ -)\n${usage}`);
    return 2;
  }
  console.log(`evals:run — label "${label}"\n`);
  let results: EvalResult[];
  try {
    results = await runBattery(arg("filter"), ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const finishedAt = new Date().toISOString();

  const passed = results.filter((result) => result.status === "passed").length;
  const scorecard: Scorecard = {
    label,
    startedAt: new Date().toISOString(),
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

// ── review (deterministic diff gate + agent first-pass) ──────

function sh(cwd: string, file: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveReviewBase(): string {
  const explicit = arg("base");
  return explicit
    ? sh(ROOT, "git", ["merge-base", explicit, "HEAD"])
    : sh(ROOT, "git", ["merge-base", "origin/main", "HEAD"]);
}

/** Prepare the base worktree for the battery: a real frozen install wires
 * the full per-package node_modules layout bun uses (workspace links point at
 * the worktree's own packages — candidate sources can never leak in), then a
 * build because dist/ is gitignored and the gates import compiled entries. */
function prepareWorktree(worktreePath: string): void {
  sh(worktreePath, "bun", ["install", "--frozen-lockfile"]);
  sh(worktreePath, "bun", ["run", "build"]);
}

async function review(): Promise<number> {
  let mergeBase: string;
  try {
    mergeBase = resolveReviewBase();
  } catch {
    console.error("review requires a diff base: pass --base <ref> or ensure origin/main exists");
    return 2;
  }
  const label = arg("label") ?? `review-${mergeBase.slice(0, 8)}`;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label)) {
    console.error(`--label must be alphanumeric (with . _ -)`);
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

  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];

  // 1. Candidate battery on the current tree.
  console.log(`evals:review — base ${mergeBase.slice(0, 8)}, candidate HEAD, reviewer ${kind}\n`);
  console.log("[1/4] candidate battery");
  results.push(...(await runBattery(undefined, ROOT)));

  // 2. Base battery in a throwaway worktree at the merge-base.
  console.log("\n[2/4] base battery (throwaway worktree)");
  const worktreePath = `${tmpdir()}/swarm-dao-review-${mergeBase.slice(0, 8)}-${Date.now()}`;
  let baseResults: EvalResult[] = [];
  try {
    sh(ROOT, "git", ["worktree", "add", "--detach", worktreePath, mergeBase]);
    prepareWorktree(worktreePath);
    // Base-battery lines carry a "base " prefix: the PR comment's findings
    // filter anchors on ^FAIL/^PASS, so a gate that legitimately cannot run
    // on the base tree (e.g. a gate introduced by this PR) is reported as an
    // "improved" line only, never as an alarming bare FAIL.
    baseResults = await runBattery(undefined, worktreePath, "base ");
  } catch (error) {
    const err = error as { message?: string; stdout?: string; stderr?: string };
    const detail = [err.message, err.stdout, err.stderr].filter(Boolean).join("\n");
    console.error(`base battery could not run: ${detail.slice(-2000)}`);
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: ROOT, stdio: "ignore" });
    } catch {
      // leave the worktree for manual cleanup rather than failing the review
    }
  }
  const diff = compareScorecards(
    {
      label: "base",
      startedAt,
      finishedAt: startedAt,
      results: baseResults,
      summary: { total: baseResults.length, passed: 0, failed: 0, totalMs: 0 },
    },
    {
      label: "candidate",
      startedAt,
      finishedAt: startedAt,
      results,
      summary: { total: results.length, passed: 0, failed: 0, totalMs: 0 },
    },
  );
  for (const regression of diff.regressions) {
    console.error(`REGRESSION  ${regression.id} — passed on base, failed on candidate`);
    if (regression.stderrTail) console.error(regression.stderrTail);
  }

  for (const improvement of diff.improvements) console.log(`improved    ${improvement.id} (failed on base)`);

  // 3. Changeset coverage for the diff (PR-aware check).
  console.log("\n[3/4] changeset coverage");
  const changesetsStart = Date.now();
  let changesetsPassed = true;
  try {
    sh(ROOT, "bun", ["run", "check:changesets"], { BASE_SHA: mergeBase });
    console.log("PASS  changesets.coverage");
  } catch {
    changesetsPassed = false;
    console.error("FAIL  changesets.coverage — diff touches published package src without a changeset");
  }
  results.push({
    id: "changesets.coverage",
    command: "bun run check:changesets",
    status: changesetsPassed ? "passed" : "failed",
    exitCode: changesetsPassed ? 0 : 1,
    durationMs: Date.now() - changesetsStart,
  });

  // 4. Agent first-pass review of the diff (skippable for a deterministic
  // review in CI, where herdr/model access may not exist).
  if (!argv.includes("--no-agent")) {
    console.log("\n[4/4] agent review");
    const reviewStart = Date.now();
    const harvest = await runHerdrWorker(
      {
        workDir: ROOT,
        kind,
        agentArgs: model && modelFlag ? [modelFlag, model] : undefined,
        timeoutMs: 600_000,
        stablePolls: 3,
      },
      `eval-review-${mergeBase.slice(0, 8)}`.slice(0, 32),
      buildReviewPrompt(mergeBase),
    );
    const reviewMs = Date.now() - reviewStart;
    const answer = harvest.ok ? extractLastJsonObject(harvest.content) : null;
    if (!harvest.ok) console.error(harvest.error);
    for (const graded of gradeReviewAnswer(answer).results) {
      const mark = graded.passed ? "PASS" : "FAIL";
      console.log(`${mark}  ${graded.id} (${reviewMs}ms)  ${graded.detail}`);
      results.push({
        id: graded.id,
        command: `evals:review agent (${kind})`,
        status: graded.passed ? "passed" : "failed",
        exitCode: graded.passed ? 0 : 1,
        durationMs: reviewMs,
        stderrTail: graded.passed ? undefined : graded.detail,
      });
    }
  }

  const scorecard: Scorecard = {
    label,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      totalMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    },
  };
  const outPath = arg("json") ?? path.join(DEFAULT_EVIDENCE_DIR, `${label}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  console.log(
    `\nsummary: ${scorecard.summary.passed}/${scorecard.summary.total} passed — scorecard: ${path.relative(ROOT, outPath)}`,
  );
  return scorecard.summary.failed > 0 ? 1 : 0;
}

// ── Dispatch ────────────────────────────────────────────────

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
  case "review":
    process.exit(await review());
    break;
  case "compare":
    process.exit(compare());
    break;
  default:
    console.error(usage);
    process.exit(subcommand === undefined ? 0 : 2);
}
