// ============================================================
// Swarm DAO Core — Git Worktree Workspace Adapter
// ============================================================
// Implements ExecutionWorkspacePort with `git worktree add`, the swarm-forge
// isolation pattern: each execution gets its own branch checked out in its
// own directory, so concurrent executions never collide in the shared
// checkout. Read-only with respect to DAO state; it only touches git.

import { type ExecutionIsolationOptions, planExecutionIsolation } from "../delivery/execution-isolation.js";
import { slugify } from "../integrations/utils.js";
import type { CommandRunnerPort } from "../ports/host.js";
import type { ExecutionWorkspacePort, ExecutionWorkspaceResult } from "../ports/workspace.js";
import type { Proposal } from "../types/index.js";

const GIT_TIMEOUT_MS = 60_000;

/**
 * Build the workspace port from a project config: undefined (no isolation)
 * unless config.execution.isolation === "worktree". Fails closed — an absent
 * or malformed config never enables isolation.
 */
export function createExecutionWorkspace(
  execution: { isolation?: string; worktreeRoot?: string; baseBranch?: string } | undefined,
  runner: CommandRunnerPort,
  repositoryRoot: string,
): ExecutionWorkspacePort | undefined {
  if (execution?.isolation !== "worktree") return undefined;
  return new GitWorkspace({
    runner,
    repositoryRoot,
    isolation: "worktree",
    worktreeRoot: execution.worktreeRoot,
    baseBranch: execution.baseBranch ?? null,
  });
}

export interface GitWorkspaceOptions extends ExecutionIsolationOptions {
  /** Runs shell commands (typically the host adapter's exec). */
  runner: CommandRunnerPort;
  /** Absolute path of the repository the worktrees are carved from. */
  repositoryRoot: string;
}

const BRANCH_EXISTS = /already exists/i;

export class GitWorkspace implements ExecutionWorkspacePort {
  readonly #options: GitWorkspaceOptions;

  public constructor(options: GitWorkspaceOptions) {
    this.#options = options;
  }

  public async prepare(proposal: Pick<Proposal, "id" | "title">): Promise<ExecutionWorkspaceResult> {
    const plan = planExecutionIsolation(proposal, this.#options);
    if (plan.mode === "none") {
      // No isolation: still report the deterministic branch name so the
      // execution snapshot can carry it, but change nothing on disk.
      return { ok: true, branch: `dao/${proposal.id}-${slugify(proposal.title) || "proposal"}`, path: null };
    }

    // Idempotent retry: the worktree may already exist and be checked out on
    // the target branch (previous attempt, re-run of dao_execute).
    const current = await this.#exec(`git -C ${plan.path} rev-parse --abbrev-ref HEAD`);
    if (current.ok && current.stdout.trim() === plan.branch) {
      return { ok: true, branch: plan.branch, path: `${this.#options.repositoryRoot}/${plan.path}` };
    }

    const base = plan.baseBranch ? ` ${plan.baseBranch}` : "";
    const created = await this.#exec(`git worktree add -b ${plan.branch} ${plan.path}${base}`);
    if (created.ok) {
      return { ok: true, branch: plan.branch, path: `${this.#options.repositoryRoot}/${plan.path}` };
    }

    // The branch may already exist from a previous attempt: attach a new
    // worktree to the existing branch instead of failing.
    if (BRANCH_EXISTS.test(created.error)) {
      const attached = await this.#exec(`git worktree add ${plan.path} ${plan.branch}`);
      if (attached.ok) {
        return { ok: true, branch: plan.branch, path: `${this.#options.repositoryRoot}/${plan.path}` };
      }
      return { ok: false, error: attached.error };
    }

    return { ok: false, error: created.error };
  }

  async #exec(command: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
      const { stdout, stderr, exitCode } = await this.#options.runner.exec(command, {
        cwd: this.#options.repositoryRoot,
        timeout: GIT_TIMEOUT_MS,
      });
      if (exitCode === 0) return { ok: true, stdout };
      const detail = [stderr.trim(), stdout.trim()].find((value) => value.length > 0) ?? "git failed";
      return { ok: false, error: detail };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "git exec failed";
      return { ok: false, error: message };
    }
  }
}
