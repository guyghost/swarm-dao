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
//
// Security: every value that later reaches a shell command line (worktree
// root, base branch) is validated here against a strict charset. Anything
// ambiguous — absolute paths, `..` segments, leading dashes, shell
// metacharacters — fails closed as an `invalid` plan, which surfaces as a
// preparation error and leaves the proposal `controlled`.

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
      mode: "invalid";
      /** Why the requested isolation was refused (surfaced to the operator). */
      error: string;
    }
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
 * Relative path segment charset: alphanumerics plus `._-`, optionally
 * leading with `.` (dotfile roots like `.dao`). Never leading with `-`
 * (option smuggling); the literal `.` and `..` segments are rejected
 * separately below. This set excludes every shell metacharacter and path
 * separators.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9.][A-Za-z0-9._-]*$/;

/**
 * Git refname charset for a base branch: segments as above joined by `/`,
 * with no `..`, no leading `-`, no trailing `/` or `/.`, no consecutive
 * slashes, and no trailing `.lock`.
 */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validateWorktreeRoot(root: string): string | null {
  if (root.length === 0) return "worktreeRoot must not be empty";
  if (root.startsWith("/")) return "worktreeRoot must be relative to the repository root";
  const segments = root.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return "worktreeRoot must not contain empty or consecutive '/' segments";
    if (segment === "." || segment === "..") return `worktreeRoot must not contain '${segment}' segments`;
    if (!SAFE_SEGMENT.test(segment)) {
      return `worktreeRoot segment '${segment}' must match ${SAFE_SEGMENT.toString()}`;
    }
  }
  return null;
}

function validateBaseBranch(branch: string): string | null {
  if (branch.length === 0) return "baseBranch must not be empty";
  if (!SAFE_REF.test(branch)) return `baseBranch '${branch}' must match ${SAFE_REF.toString()}`;
  if (branch.includes("..")) return "baseBranch must not contain '..'";
  if (branch.endsWith("/") || branch.endsWith("/.") || branch.endsWith(".lock")) {
    return `baseBranch '${branch}' is not a valid git refname`;
  }
  return null;
}

/**
 * Derive the isolation plan for a proposal. Deterministic and side-effect
 * free: the same proposal and options always yield the same branch and
 * path. Unknown modes fail closed to "none"; unsafe configuration fails
 * closed to "invalid" (never to silent shell interpolation).
 */
export function planExecutionIsolation(
  proposal: Pick<Proposal, "id" | "title">,
  options: ExecutionIsolationOptions = {},
): ExecutionIsolationPlan {
  if (options.isolation !== "worktree") return { mode: "none" };

  const root = options.worktreeRoot && options.worktreeRoot.length > 0 ? options.worktreeRoot : DEFAULT_WORKTREE_ROOT;
  const rootError = validateWorktreeRoot(root);
  if (rootError) return { mode: "invalid", error: rootError };

  const rawBase = options.baseBranch;
  if (typeof rawBase === "string") {
    if (rawBase.length === 0) return { mode: "invalid", error: "baseBranch must not be empty" };
    const branchError = validateBaseBranch(rawBase);
    if (branchError) return { mode: "invalid", error: branchError };
  }
  const baseBranch = typeof rawBase === "string" ? rawBase : null;

  // slugify() output is strictly [a-z0-9-], so the derived branch and path
  // inherit the validated charset of the root.
  const slug = slugify(proposal.title) || "proposal";
  const trimmedRoot = root.replace(/\/+$/, "");
  return {
    mode: "worktree",
    branch: `dao/${proposal.id}-${slug}`,
    path: `${trimmedRoot}/${proposal.id}-${slug}`,
    baseBranch,
  };
}
