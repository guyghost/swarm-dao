// ============================================================
// Swarm DAO Core — Execution Isolation (pure planning)
// ============================================================
// Plans how a proposal's execution workspace is isolated. Inspired by
// swarm-forge's per-role worktrees: concurrent executions must never step
// on each other in the shared checkout.
//
// This module is pure: it derives a deterministic plan (branch + worktree
// path) from the proposal. Running `git worktree add` is a technical effect
// that lives behind a port (see ports/workspace.ts and
// adapters/git-workspace.ts). The proposal machine remains the only
// authority for proposal state; isolation never transitions anything.

import { slugify } from "../integrations/utils.js";
import type { Proposal } from "../types/index.js";

export type ExecutionIsolationMode = "none" | "worktree";

export interface ExecutionIsolationOptions {
  /** "none" (default, no isolation) or "worktree" (dedicated worktree). */
  isolation?: ExecutionIsolationMode;
  /** Directory (relative to the repository root) holding worktrees. */
  worktreeRoot?: string;
  /** Base branch for the execution branch; null lets git use HEAD. */
  baseBranch?: string | null;
}

export type ExecutionIsolationPlan =
  | { mode: "none" }
  | {
      mode: "worktree";
      /** Branch checked out in the worktree (same scheme as GitHub branches). */
      branch: string;
      /** Worktree path relative to the repository root. */
      path: string;
      /** Configured base branch, or null for git's default (HEAD). */
      baseBranch: string | null;
    };

export const DEFAULT_WORKTREE_ROOT = ".dao/worktrees";

/**
 * Derive the isolation plan for a proposal. Deterministic and side-effect
 * free: the same proposal and options always yield the same branch and
 * path. Unknown modes fail closed to "none".
 */
export function planExecutionIsolation(
  proposal: Pick<Proposal, "id" | "title">,
  options: ExecutionIsolationOptions = {},
): ExecutionIsolationPlan {
  if (options.isolation !== "worktree") return { mode: "none" };

  const slug = slugify(proposal.title) || "proposal";
  const root = options.worktreeRoot && options.worktreeRoot.length > 0 ? options.worktreeRoot : DEFAULT_WORKTREE_ROOT;
  const trimmedRoot = root.replace(/\/+$/, "");
  return {
    mode: "worktree",
    branch: `dao/${proposal.id}-${slug}`,
    path: `${trimmedRoot}/${proposal.id}-${slug}`,
    baseBranch: typeof options.baseBranch === "string" && options.baseBranch.length > 0 ? options.baseBranch : null,
  };
}
