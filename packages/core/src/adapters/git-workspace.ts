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
 * unless config.execution.isolation is "worktree" or "sandbox" (ADR-003).
 * Fails closed — an absent or malformed config never enables isolation; a
 * malformed sandbox section surfaces as an invalid plan at prepare time.
 */
export function createExecutionWorkspace(
  execution:
    | {
        isolation?: string;
        worktreeRoot?: string;
        baseBranch?: string;
        sandbox?: { runtime?: string; image?: string; cpus?: number; memoryMb?: number };
      }
    | undefined,
  runner: CommandRunnerPort,
  repositoryRoot: string,
): ExecutionWorkspacePort | undefined {
  if (execution?.isolation !== "worktree" && execution?.isolation !== "sandbox") return undefined;
  // Raw pass-through: the planner validates runtime/image and fails closed on
  // invalid config (coercing "podman" to docker would fake the boundary —
  // Copilot review on #85).
  const sandbox = execution.isolation === "sandbox" ? execution.sandbox : undefined;
  return new GitWorkspace({
    runner,
    repositoryRoot,
    isolation: execution.isolation,
    worktreeRoot: execution.worktreeRoot,
    baseBranch: execution.baseBranch ?? null,
    ...(sandbox ? { sandbox } : {}),
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
    if (plan.mode === "invalid") {
      // Unsafe configuration (absolute root, `..`, metacharacters, …) must
      // never reach a shell command line. Fail closed.
      return { ok: false, error: `invalid execution isolation config: ${plan.error}` };
    }
    if (plan.mode === "none") {
      // No isolation: still report the deterministic branch name so the
      // execution snapshot can carry it, but change nothing on disk.
      return { ok: true, branch: `dao/${proposal.id}-${slugify(proposal.title) || "proposal"}`, path: null };
    }

    if (plan.mode === "sandbox") {
      // Probe the runtime before touching git: an evolution that cannot be
      // bounded must not silently degrade to host execution (ADR-003).
      const probe = await this.#exec(`${plan.runtime} --version`);
      if (!probe.ok) {
        return {
          ok: false,
          error:
            `sandbox runtime '${plan.runtime}' is not available on this host (${probe.error}). ` +
            `Install Docker or Apple container, or set execution.isolation to "worktree".`,
        };
      }
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
