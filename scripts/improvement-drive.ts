#!/usr/bin/env bun
// Swarm DAO — dogfood driver: runs an improvement series continuously.
//
// Repeatedly advances the series one state-authorized effect at a time
// (OrchestratorRunner#once), pausing through cooldowns, until the machine
// reaches a terminal state (idle/cancelled) or a human-gated state
// (workerFailed/halted/awaitingHumanCycleDecision). Single-process by
// design: the series journal assumes one runner (see orchestrator.ts).
//
// Every effect is journaled by the runner, so the driver is resumable:
// kill it any time and re-run to continue where it stopped.
//
// Usage:
//   bun scripts/improvement-drive.ts --series-id <id> [--max-effects <n>] [--evidence-root <path>]

import { resolve } from "node:path";
import { ORCHESTRATOR_TERMINAL_STATES } from "../packages/core/src/models/improvement-orchestrator.machine.js";
import { DEFAULT_SERIES_EVIDENCE_ROOT, OrchestratorRunner } from "../packages/improvement-loop/src/orchestrator.js";

const usage = `Usage:
  bun scripts/improvement-drive.ts --series-id <id> [--max-effects <n=0=unlimited>] [--evidence-root <path>]`;

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const seriesId = arg("series-id");
if (!seriesId) {
  console.error(usage);
  process.exit(1);
}
const maxEffects = Number(arg("max-effects") ?? 0);
if (!Number.isInteger(maxEffects) || maxEffects < 0) {
  console.error(`--max-effects must be an integer >= 0 (0 = unlimited)\n${usage}`);
  process.exit(1);
}
const evidenceRoot = resolve(import.meta.dir, "..", arg("evidence-root") ?? DEFAULT_SERIES_EVIDENCE_ROOT);

const HUMAN_GATED = new Set(["workerFailed", "halted", "awaitingHumanCycleDecision"]);
const log = (line: string): void => {
  console.log(`[drive ${new Date().toISOString()}] ${line}`);
};

const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
log(`driving series ${seriesId} (evidence: ${evidenceRoot})`);

let effects = 0;
try {
  while (maxEffects === 0 || effects < maxEffects) {
    const before = runner.snapshot();
    if ((ORCHESTRATOR_TERMINAL_STATES as readonly string[]).includes(before.state)) {
      log(
        `series is terminal (${before.state})${before.context.terminalReason ? `: ${before.context.terminalReason}` : ""}`,
      );
      break;
    }
    if (HUMAN_GATED.has(before.state)) {
      log(`human decision required (${before.state}): ${before.context.pendingReason ?? "see journal"}`);
      break;
    }
    const result = await runner.once();
    effects += 1;
    log(
      `effect ${effects}: ${result.stateBefore} -> ${result.stateAfter}` +
        ` executed=${result.executed}` +
        (result.detail ? ` — ${result.detail}` : ""),
    );
    if (result.stateAfter === "cooldown") {
      const after = runner.snapshot();
      const enteredAt = after.cooldownEnteredAt ? Date.parse(after.cooldownEnteredAt) : Number.NaN;
      const remaining = enteredAt + (after.context.cooldownMs ?? 0) - Date.now();
      if (Number.isFinite(enteredAt) && remaining > 0) {
        log(`cooldown; sleeping ${Math.ceil(remaining / 1000)}s`);
        await Bun.sleep(remaining + 250);
      }
    } else if (!result.executed) {
      // No-op effect (e.g. gate rejection): back off briefly instead of spinning.
      await Bun.sleep(1000);
    }
  }
} catch (error) {
  process.exitCode = 1;
  log(`driver stopped by error (series state is journaled; re-run to resume): ${String(error)}`);
}
log(`done after ${effects} effect(s); final state: ${runner.snapshot().state}`);
