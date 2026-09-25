// ============================================================
// Swarm DAO Core — DAO Home Naming (ADR-007, pure functions)
// ============================================================
// Pure naming/derivation helpers for the external DAO home
// (`~/.swarm-dao/<project-id>/branches/<branch-id>/`). No I/O here:
// effects live in `dao-home.ts`; unit tests hit these functions directly.

import { createHash } from "node:crypto";

/** Lowercase, `[a-z0-9-]` only, capped at 80 chars, never empty.
 *  Dash-trimming is a manual slice on purpose: chained dash regexes over
 *  uncontrolled input make every pass re-scan the dash runs the previous
 *  pass produced (CodeQL polynomial-ReDoS, PR #205). */
export function slugifyDirName(value: string, fallback = "default"): string {
  const collapsed = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80);
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 45 /* "-" */) start++;
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end--;
  return end > start ? collapsed.slice(start, end) : fallback;
}

/**
 * Deterministic project identity (ADR-007 §2): `<slug(repo name)>-<hash8>`.
 * The caller passes the realpath-resolved repo root so that linked
 * worktrees of the same repo collide onto one project while two clones of
 * the same repo never do. No registry index: the id is fully derivable.
 */
export function deriveProjectId(repoRoot: string, repoName: string): string {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  return `${slugifyDirName(repoName, "project")}-${hash}`;
}

/**
 * Branch/worktree state directory name (ADR-007 §3): the checked-out branch
 * (a branch is checked out in at most one worktree, so the branch key
 * already disambiguates worktrees), `detached-<sha8>` for detached HEADs,
 * `default` when no git identity exists. Branch names include a hash of their exact spelling, preserving identity
 * across punctuation, case, and truncation of the readable prefix.
 */
export function branchDirName(branch: string | null, headSha: string | null): string {
  if (branch !== null && branch !== "HEAD") {
    const hash = createHash("sha256").update(branch).digest("hex").slice(0, 16);
    return `branch-${slugifyDirName(branch, "branch")}-${hash}`;
  }
  if (headSha !== null && headSha.length > 0) return `detached-${headSha.slice(0, 8)}`;
  return "default";
}

/**
 * GC diff (ADR-007 §5): a present directory is stale when it is neither the
 * current branch dir, nor a live ref/worktree id. Detached ids match live by
 * sha-prefix so short/long sha spellings stay compatible.
 */
export function planGcDirs(present: readonly string[], liveIds: ReadonlySet<string>, keepId: string | null): string[] {
  return present.filter((dir) => {
    if (dir === keepId || liveIds.has(dir)) return false;
    if (dir.startsWith("detached-")) {
      const prefix = dir.slice("detached-".length);
      for (const id of liveIds) {
        if (id.startsWith("detached-") && id.slice("detached-".length).startsWith(prefix)) return false;
      }
    }
    return true;
  });
}
