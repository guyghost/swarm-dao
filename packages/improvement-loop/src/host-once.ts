// ============================================================
// Swarm DAO Improvement Loop — host-triggered series advance
// ============================================================
// `advanceSeriesOnce` is the single entry AI-facing hosts (MCP server, Pi
// adapter, …) should use to advance an improvement series by exactly one
// state-authorized effect. It mirrors `swarm-dao improve once --series-id X`
// with ONE deliberate difference: the host supplies no execution options.
//
// The authority model stays intact:
// - The frozen orchestrator machine decides which effect (if any) runs; the
//   human-decision, worker-failed, halted and terminal states are no-ops.
// - The execution environment comes from the operator's persisted project
//   configuration only (.dao/improvement.json worker/sandbox sections).
// - Workers and anchor commands run inside the per-series worktree
//   (.dao/worktrees/dao/loop/<series-id>), so a host-triggered advance never
//   races the operator's working tree. The worktree is created/reused
//   idempotently (never removed here).
//
// The AI can pull the trigger; it can never aim it.

import { resolve } from "node:path";
import { loadProjectImprovementConfig, sandboxRequestFromConfig, workerOptionsFromConfig } from "./config.js";
import { type OrchestratorOnceResult, OrchestratorRunner } from "./orchestrator.js";
import { resolveSandboxRunCommand } from "./sandbox.js";
import { ensureSeriesWorktree } from "./worktree.js";

export interface AdvanceSeriesOnceOptions {
  seriesId: string;
  /** Project root: git repo the worktree is carved from, and where the
   * persisted project configuration and evidence roots are read. */
  workDir: string;
  /** Series evidence root, resolved against workDir. Defaults to
   * `.dao/improvement-series` (the CLI default). */
  evidenceRoot?: string;
  /** Improvement cycle evidence root, resolved against workDir. Defaults to
   * `.dao/improvement-cycles` (the CLI default). Series that live under
   * `evidence/` (the repo's own dogfood) pass their cycle root here. */
  cycleEvidenceRoot?: string;
}

/** Advance a series by one authorized effect using only persisted configuration. */
export async function advanceSeriesOnce(options: AdvanceSeriesOnceOptions): Promise<OrchestratorOnceResult> {
  const { seriesId, workDir } = options;
  const evidenceRoot = resolve(workDir, options.evidenceRoot ?? ".dao/improvement-series");
  const cycleEvidenceRoot = resolve(workDir, options.cycleEvidenceRoot ?? ".dao/improvement-cycles");

  const config = await loadProjectImprovementConfig(workDir);
  const worktree = await ensureSeriesWorktree({ repoDir: workDir, seriesId });
  const runCommand = await resolveSandboxRunCommand(sandboxRequestFromConfig(config), worktree.path);
  const runner = await OrchestratorRunner.create({ seriesId, evidenceRoot });
  return runner.once({
    workDir: worktree.path,
    cycleEvidenceRoot,
    worker: workerOptionsFromConfig(config),
    ...(runCommand ? { runCommand } : {}),
  });
}
