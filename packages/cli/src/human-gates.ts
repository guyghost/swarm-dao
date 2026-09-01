// Swarm DAO CLI — human-gate commands.
//
// These commands replace hand-written JSON signal files for every human
// channel event: they read the run state, show the exact decision inputs
// (hashes, reasons), require an explicit confirmation, and only then submit
// through the same runners the file-based flow uses. Nothing here bypasses a
// machine guard — a wrong state still ends as a machine rejection (exit 2).

import { createInterface } from "node:readline/promises";
import { createGraphRunner } from "@guyghost/swarm-dao-graph";
import { createImprovementRunner, type ImprovementRunner, OrchestratorRunner } from "@guyghost/swarm-dao-improvement";
import { c, GLYPH, truncateHash } from "./render.js";
import {
  CYCLE_ROOT_CANDIDATES,
  GRAPH_ROOT_CANDIDATES,
  locateRoot,
  readJsonOrNull,
  SERIES_ROOT_CANDIDATES,
} from "./roots.js";

export class GateError extends Error {}

function gateErr(msg: string): never {
  throw new GateError(msg);
}

const stringFlag = (flags: Record<string, string | true>, name: string): string | undefined => {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) gateErr(`--${name} requires a value`);
  return value;
};

const nowIso = (): string => new Date().toISOString();

/** Explicit confirmation; refuses to run non-interactively without --yes. */
export async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (process.stdin.isTTY !== true) {
    gateErr("refusing to submit a human event non-interactively — review the inputs above, then re-run with --yes");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function reportSubmission(accepted: boolean, beforeState: string, afterState: string, eventType: string): number {
  if (!accepted) {
    process.stdout.write(`${GLYPH.fail} ${eventType} rejected by the machine (${beforeState} → ${afterState})\n`);
    return 2;
  }
  process.stdout.write(`${GLYPH.ok} ${eventType} submitted — state is now ${c.info(afterState)}\n`);
  return 0;
}

// ── Graph run gates ─────────────────────────────────────────

export async function cmdApprove(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const runId = stringFlag(flags, "run-id");
  if (!runId) gateErr("--run-id is required\nusage: swarm-dao approve --run-id <id> [--evidence-root <path>] [--yes]");
  const evidenceRoot = stringFlag(flags, "evidence-root");
  const located = await locateRoot(cwd, runId, GRAPH_ROOT_CANDIDATES, evidenceRoot);
  const runner = await createGraphRunner({ evidenceRoot: located.root, runId });
  const snapshot = runner.snapshot();
  if (snapshot.state !== "awaitingApproval") {
    gateErr(`run '${runId}' is '${snapshot.state}', not awaitingApproval — nothing to approve`);
  }
  const modelHash = String(snapshot.context.modelHash ?? "");
  process.stdout.write(`run:    ${c.bold(runId)} (${located.root})\n`);
  process.stdout.write(`model:  ${modelHash}\n`);
  process.stdout.write(c.dim("verify this hash yourself before approving (it binds the exact frozen model)\n"));
  const ok = await confirm(`Approve model ${truncateHash(modelHash)}?`, flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({
    runId,
    type: "MODEL_APPROVED",
    source: "human",
    producer: "human-owner",
    occurredAt: nowIso(),
    payload: { modelHash },
    evidence: ["owner approval via swarm-dao approve"],
  });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "MODEL_APPROVED");
}

export async function cmdReject(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const runId = stringFlag(flags, "run-id");
  const reason = stringFlag(flags, "reason");
  if (!runId || !reason)
    gateErr("--run-id and --reason are required\nusage: swarm-dao reject --run-id <id> --reason <text> [--yes]");
  const evidenceRoot = stringFlag(flags, "evidence-root");
  const located = await locateRoot(cwd, runId, GRAPH_ROOT_CANDIDATES, evidenceRoot);
  const runner = await createGraphRunner({ evidenceRoot: located.root, runId });
  const snapshot = runner.snapshot();
  if (snapshot.state !== "awaitingApproval") {
    gateErr(`run '${runId}' is '${snapshot.state}', not awaitingApproval — nothing to reject`);
  }
  process.stdout.write(`run:    ${c.bold(runId)}\nreason: ${reason}\n`);
  const ok = await confirm("Send the model back to draft?", flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({
    runId,
    type: "MODEL_REJECTED",
    source: "human",
    producer: "human-owner",
    occurredAt: nowIso(),
    payload: { reason },
    evidence: ["owner rejection via swarm-dao reject"],
  });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "MODEL_REJECTED");
}

// ── Improvement cycle / series gates ────────────────────────

interface CycleSnapshotShape {
  cycleId: string;
  state: string;
  context: { scope?: string; referenceHash?: string; attempt?: number; maxRetries?: number };
}

async function loadCycleRunner(
  cwd: string,
  cycleId: string,
  flags: Record<string, string | true>,
): Promise<{ runner: ImprovementRunner; snapshot: CycleSnapshotShape; root: string }> {
  const located = await locateRoot(cwd, cycleId, CYCLE_ROOT_CANDIDATES, stringFlag(flags, "cycle-root"));
  const snapshot = (await readJsonOrNull(`${located.root}/${cycleId}/snapshot.json`)) as CycleSnapshotShape | null;
  if (!snapshot) gateErr(`cycle '${cycleId}' not found (tried: ${located.tried.join(", ")})`);
  const runner = await createImprovementRunner({
    evidenceRoot: located.root,
    cycleId,
    scope: snapshot?.context.scope ?? "default",
    referenceHash: snapshot?.context.referenceHash ?? "",
  });
  return { runner, snapshot: snapshot as CycleSnapshotShape, root: located.root };
}

async function resolveCycleId(cwd: string, flags: Record<string, string | true>): Promise<string> {
  const cycleId = stringFlag(flags, "cycle-id");
  if (cycleId) return cycleId;
  const seriesId = stringFlag(flags, "series-id");
  if (!seriesId) {
    gateErr("--cycle-id (or --series-id to resolve the active cycle) is required");
  }
  const located = await locateRoot(cwd, seriesId, SERIES_ROOT_CANDIDATES, stringFlag(flags, "evidence-root"));
  const snapshot = (await readJsonOrNull(`${located.root}/${seriesId}/snapshot.json`)) as {
    context?: { improvementCycleId?: string | null };
  } | null;
  const active = snapshot?.context?.improvementCycleId;
  if (!active)
    gateErr(
      `series '${seriesId}' has no active cycle — use --cycle-id or check: swarm-dao improve status --series-id ${seriesId}`,
    );
  return active;
}

export async function cmdImproveRetry(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const cycleId = await resolveCycleId(cwd, flags);
  const { runner, snapshot } = await loadCycleRunner(cwd, cycleId, flags);
  if (snapshot.state !== "retrying") {
    gateErr(`cycle '${cycleId}' is '${snapshot.state}', not retrying — nothing to authorize`);
  }
  process.stdout.write(
    `cycle:  ${c.bold(cycleId)}\nretry:  attempt ${(snapshot.context.attempt ?? 0) + 1} of ${(snapshot.context.maxRetries ?? 0) + 1} max\n`,
  );
  const ok = await confirm("Authorize the retry?", flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({
    cycleId,
    type: "RETRY_AUTHORIZED",
    source: "human",
    producer: "human-owner",
    occurredAt: nowIso(),
    payload: {},
    evidence: ["owner authorization via swarm-dao improve retry"],
  });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "RETRY_AUTHORIZED");
}

export async function cmdImproveReference(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const decision = stringFlag(flags, "decision");
  if (decision !== "approve" && decision !== "reject") gateErr("--decision must be approve or reject");
  const cycleId = await resolveCycleId(cwd, flags);
  const { runner, snapshot } = await loadCycleRunner(cwd, cycleId, flags);
  if (snapshot.state !== "adjusting") {
    gateErr(`cycle '${cycleId}' is '${snapshot.state}', not adjusting — nothing to decide`);
  }
  const referenceHash = String(snapshot.context.referenceHash ?? "");
  process.stdout.write(`cycle:     ${c.bold(cycleId)}\nreference: ${referenceHash}\ndecision:  ${decision}\n`);
  if (decision === "reject") {
    const reason = stringFlag(flags, "reason") ?? gateErr("--reason is required to reject a reference change");
    process.stdout.write(`reason:    ${reason}\n`);
    const ok = await confirm("Reject this reference change?", flags.yes === true);
    if (!ok) {
      process.stdout.write("aborted — nothing was submitted\n");
      return 0;
    }
    const result = await runner.submit({
      cycleId,
      type: "REFERENCE_CHANGE_REJECTED",
      source: "human",
      producer: "human-owner",
      occurredAt: nowIso(),
      payload: { reason },
      evidence: ["owner rejection via swarm-dao improve reference"],
    });
    return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "REFERENCE_CHANGE_REJECTED");
  }
  const ok = await confirm("Approve this exact reference?", flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({
    cycleId,
    type: "REFERENCE_CHANGE_APPROVED",
    source: "human",
    producer: "human-owner",
    occurredAt: nowIso(),
    payload: { referenceHash },
    evidence: ["owner approval via swarm-dao improve reference"],
  });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "REFERENCE_CHANGE_APPROVED");
}

export async function cmdImproveCancelCycle(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const reason = stringFlag(flags, "reason");
  if (!reason) gateErr("--reason is required (the journal records why the cycle was cancelled)");
  const cycleId = await resolveCycleId(cwd, flags);
  const { runner, snapshot } = await loadCycleRunner(cwd, cycleId, flags);
  if (snapshot.state === "cancelled" || snapshot.state === "succeeded" || snapshot.state === "failed") {
    gateErr(`cycle '${cycleId}' is already terminal (${snapshot.state}) — nothing to cancel`);
  }
  process.stdout.write(`cycle:  ${c.bold(cycleId)} (${snapshot.state})\nreason:  ${reason}\n`);
  const ok = await confirm("Cancel this cycle? This is terminal.", flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({
    cycleId,
    type: "CANCEL",
    source: "human",
    producer: "human-owner",
    occurredAt: nowIso(),
    payload: { reason },
    evidence: ["owner cancellation via swarm-dao improve cancel-cycle"],
  });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "CANCEL");
}

async function seriesRunner(
  cwd: string,
  flags: Record<string, string | true>,
): Promise<{ runner: OrchestratorRunner; snapshot: ReturnType<OrchestratorRunner["snapshot"]>; root: string }> {
  const seriesId = stringFlag(flags, "series-id");
  if (!seriesId) gateErr("--series-id is required");
  const located = await locateRoot(cwd, seriesId, SERIES_ROOT_CANDIDATES, stringFlag(flags, "evidence-root"));
  if (!located.found) {
    gateErr(`series '${seriesId}' not found (tried: ${located.tried.join(", ")})`);
  }
  const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot: located.root });
  return { runner, snapshot: runner.snapshot(), root: located.root };
}

export async function cmdImproveRetryWorkers(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const { runner, snapshot } = await seriesRunner(cwd, flags);
  if (snapshot.state !== "workerFailed") {
    gateErr(`series '${snapshot.context.seriesId}' is '${snapshot.state}', not workerFailed — nothing to authorize`);
  }
  process.stdout.write(
    `series:  ${c.bold(String(snapshot.context.seriesId))}\nfailure: ${snapshot.context.pendingReason ?? "unknown"}\n`,
  );
  const ok = await confirm("Retry the failed workers?", flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({ type: "RETRY_WORKERS", source: "human" });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "RETRY_WORKERS");
}

export async function cmdImproveRestart(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const { runner, snapshot } = await seriesRunner(cwd, flags);
  if (snapshot.state !== "halted") {
    gateErr(
      `series '${snapshot.context.seriesId}' is '${snapshot.state}', not halted — restart applies to halted series only`,
    );
  }
  process.stdout.write(
    `series:  ${c.bold(String(snapshot.context.seriesId))}\nhalted:  ${snapshot.context.pendingReason ?? "unknown"}\n`,
  );
  const ok = await confirm("Restart the series (preparing)?", flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({ type: "RESTART_SERIES", source: "human" });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "RESTART_SERIES");
}

export async function cmdImproveCancel(cwd: string, flags: Record<string, string | true>): Promise<number> {
  const reason = stringFlag(flags, "reason");
  if (!reason) gateErr("--reason is required (the journal records why the series was cancelled)");
  const { runner, snapshot } = await seriesRunner(cwd, flags);
  if (!snapshot.context.started) {
    gateErr(`series '${snapshot.context.seriesId}' has not started — nothing to cancel`);
  }
  process.stdout.write(
    `series:  ${c.bold(String(snapshot.context.seriesId))} (${snapshot.state})\nreason:  ${reason}\n`,
  );
  const ok = await confirm("Cancel this series? This is terminal.", flags.yes === true);
  if (!ok) {
    process.stdout.write("aborted — nothing was submitted\n");
    return 0;
  }
  const result = await runner.submit({ type: "CANCEL_SERIES", source: "human", reason });
  return reportSubmission(result.accepted, snapshot.state, result.snapshot.state ?? "?", "CANCEL_SERIES");
}
