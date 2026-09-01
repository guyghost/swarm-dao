// ============================================================
// Swarm DAO Improvement Loop — git worktree execution environment
// ============================================================
// Prepares an isolated git worktree per improvement series so loop workers
// and anchor commands observe (and only observe) a pinned checkout, while
// series/cycle evidence stays in the repository's own evidence roots.
//
// Lifecycle per series (idempotent):
//   branch dao/loop/<seriesId> missing -> git worktree add -b <branch> <path>
//   branch exists (worktree removed)   -> git worktree add <path> <branch>
//   worktree already checked out       -> reused, no git call
//
// The worktree is never removed automatically: cycles of a series build on
// each other, and cleanup is an operator decision (`git worktree remove`).
//
// Boundary: this module only prepares a directory; it never judges commands
// or emits signals. Verdicts stay with the improvement machine.

import { exec as execCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HerdrRunner } from "@guyghost/swarm-dao-herdr-adapter";

const execAsync = promisify(execCallback);

const defaultRunner = (): HerdrRunner => ({
  exec: async (command, options) => {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: options?.cwd, timeout: options?.timeout });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number | string };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message ?? "command failed",
        exitCode: Number.isInteger(failure.code) ? (failure.code as number) : 1,
      };
    }
  },
});

export interface WorktreeHandle {
  /** Absolute worktree path (workers and anchor commands run here). */
  path: string;
  /** Branch checked out in the worktree (dao/loop/<seriesId>). */
  branch: string;
  /** True when this call created the worktree; false when it was reused. */
  created: boolean;
}

const validSeriesId = (seriesId: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(seriesId) && !seriesId.includes("..");

/** Branch name for a series: dao/loop/<seriesId> (seriesId is filesystem-safe). */
export const seriesBranchName = (seriesId: string): string => `dao/loop/${seriesId}`;

/** Worktree path for a series: <repo>/.dao/worktrees/<seriesId> (gitignored). */
export const seriesWorktreePath = (repoDir: string, seriesId: string): string =>
  path.join(repoDir, ".dao", "worktrees", seriesId);

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Ensure the series worktree exists (idempotent). Commands run through the
 * injectable runner; every interpolated value is a validated seriesId or an
 * absolute path, both quoted.
 */
export async function ensureSeriesWorktree(options: {
  repoDir: string;
  seriesId: string;
  runner?: HerdrRunner;
}): Promise<WorktreeHandle> {
  if (!validSeriesId(options.seriesId)) throw new Error("seriesId must be a safe non-empty filesystem identifier");
  const branch = seriesBranchName(options.seriesId);
  const worktreePath = seriesWorktreePath(path.resolve(options.repoDir), options.seriesId);

  // A worktree is identified by its `.git` FILE (not directory) pointing at
  // the main repository's admin area. Anything else at the path is refused —
  // never clobber, never silently reuse a non-worktree directory.
  if (
    await fs.stat(worktreePath).then(
      () => true,
      () => false,
    )
  ) {
    const marker = await fs.stat(path.join(worktreePath, ".git")).catch(() => null);
    if (marker === null || !marker.isFile()) {
      throw new Error(`worktree path exists but is not a git worktree: ${worktreePath}`);
    }
    await syncProjectDaoConfig(path.resolve(options.repoDir), worktreePath);
    return { path: worktreePath, branch, created: false };
  }

  const runner = options.runner ?? defaultRunner();

  const branchExists = await runner.exec(`git rev-parse --verify --quiet refs/heads/${branch}`, {
    cwd: options.repoDir,
  });
  if (branchExists.exitCode !== 0 && branchExists.exitCode !== 1) {
    throw new Error(`git rev-parse failed: ${(branchExists.stderr || branchExists.stdout).trim().slice(0, 300)}`);
  }

  const command =
    branchExists.exitCode === 0
      ? `git worktree add ${quote(worktreePath)} ${branch}`
      : `git worktree add -b ${branch} ${quote(worktreePath)}`;
  const created = await runner.exec(command, { cwd: options.repoDir });
  if (created.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${(created.stderr || created.stdout).trim().slice(0, 300)}`);
  }
  await syncProjectDaoConfig(path.resolve(options.repoDir), worktreePath);
  return { path: worktreePath, branch, created: true };
}

/** `.dao/` is gitignored, so a fresh worktree lacks the project's improvement
 * config and anchor resolution would fail there. Copy the human-owned config
 * into the worktree on every prepare (create or reuse) so anchor commands
 * resolve exactly as in the main checkout. Never deletes: a missing source
 * leaves the worktree untouched. */
async function syncProjectDaoConfig(repoDir: string, worktreePath: string): Promise<void> {
  const source = path.join(repoDir, ".dao", "improvement.json");
  const content = await fs.readFile(source, "utf8").catch(() => null);
  if (content === null) return;
  await fs.mkdir(path.join(worktreePath, ".dao"), { recursive: true });
  await fs.writeFile(path.join(worktreePath, ".dao", "improvement.json"), content, "utf8");
}
