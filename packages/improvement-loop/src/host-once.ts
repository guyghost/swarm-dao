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

import { promises as fs } from "node:fs";
import path from "node:path";
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

function assertSafeRelativeRoot(relativeRoot: string): void {
  if (relativeRoot.includes("\0")) {
    throw new Error("Path traversal denied: null bytes are not allowed");
  }
  if (relativeRoot.trim() === "") {
    throw new Error("Path traversal denied: empty roots are not allowed");
  }
  if (path.isAbsolute(relativeRoot)) {
    throw new Error(`Path traversal denied: absolute paths are not allowed ("${relativeRoot}")`);
  }
  const segments = relativeRoot.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Path traversal denied: ".." segments are not allowed ("${relativeRoot}")`);
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  );
}

async function resolveRealBase(baseDir: string): Promise<string> {
  try {
    return await fs.realpath(baseDir);
  } catch {
    return path.resolve(baseDir);
  }
}

function getErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code: string }).code : "";
}

async function assertNearestExistingParentContained(resolvedPath: string, resolvedBase: string): Promise<void> {
  let parent = path.dirname(resolvedPath);
  while (true) {
    if (parent === resolvedPath) {
      return;
    }
    try {
      const realParent = await fs.realpath(parent);
      if (!isPathInsideRoot(resolvedBase, realParent)) {
        throw new Error("Path traversal denied: parent path escapes base directory");
      }
      return;
    } catch (parentError) {
      const parentCode = getErrorCode(parentError);
      if (parentCode !== "ENOENT") {
        throw parentError;
      }
      if (parent === resolvedBase) {
        return;
      }
      const nextParent = path.dirname(parent);
      if (nextParent === parent) {
        return;
      }
      parent = nextParent;
    }
  }
}

async function assertRealPathContained(resolvedPath: string, resolvedBase: string): Promise<void> {
  try {
    const realPath = await fs.realpath(resolvedPath);
    if (!isPathInsideRoot(resolvedBase, realPath)) {
      throw new Error("Path traversal denied: resolved path escapes base directory");
    }
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT") {
      await assertNearestExistingParentContained(resolvedPath, resolvedBase);
      return;
    }
    throw error;
  }
}

async function resolveContainedRoot(workDir: string, relativeRoot: string): Promise<string> {
  assertSafeRelativeRoot(relativeRoot);
  const resolvedBase = await resolveRealBase(workDir);
  const resolvedPath = path.resolve(resolvedBase, relativeRoot);
  if (!isPathInsideRoot(resolvedBase, resolvedPath)) {
    throw new Error(`Path traversal denied: "${relativeRoot}" is outside "${workDir}"`);
  }
  await assertRealPathContained(resolvedPath, resolvedBase);
  return resolvedPath;
}

/** Advance a series by one authorized effect using only persisted configuration. */
export async function advanceSeriesOnce(options: AdvanceSeriesOnceOptions): Promise<OrchestratorOnceResult> {
  const { seriesId, workDir } = options;
  const evidenceRoot = await resolveContainedRoot(workDir, options.evidenceRoot ?? ".dao/improvement-series");
  const cycleEvidenceRoot = await resolveContainedRoot(workDir, options.cycleEvidenceRoot ?? ".dao/improvement-cycles");

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
