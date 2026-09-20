// ============================================================
// Swarm DAO Core — DAO Home Naming (ADR-007, pure functions)
// ============================================================
// Pure naming/derivation helpers for the external DAO home
// (`~/.swarm-dao/<project-id>/branches/<branch-id>/`). No I/O here:
// effects live in `dao-home.ts`; unit tests hit these functions directly.

import { createHash } from "node:crypto";

/** Lowercase, `[a-z0-9-]` only, capped at 80 chars, never empty. */
export function slugifyDirName(value: string, fallback = "default"): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : fallback;
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
 * `default` when no git identity exists. `sep`-containing branch names are
 * flattened; `feature/x` and `feature-x` map to the same dir by design.
 */
export function branchDirName(branch: string | null, headSha: string | null): string {
  if (branch !== null && branch !== "HEAD") return slugifyDirName(branch, "branch");
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
