// ============================================================
// Swarm DAO Core — DAO Home Resolution (ADR-007, effects)
// ============================================================
// Resolves where DAO state lives for a working directory:
//
//   1. legacy `<cwd>/.dao` when it exists (existing projects: untouched)
//   2. legacy `<cwd>/.dao` when there is no git identity (home mode needs a
//      project identity; non-git projects fail closed to the local dir)
//   3. `~/.swarm-dao/<project-id>/branches/<branch-id>/` (new default)
//
// Home resolution also owns the passive GC sweep (ADR-007 §5): state dirs
// whose branch/worktree no longer exists are removed, guarded by the
// `project.json` repoPath match and never touching the current branch.

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../../observability/logging.js";
import { branchDirName, deriveProjectId, planGcDirs } from "./naming.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export type DaoHomeMode = "legacy" | "home";

export interface DaoLayout {
  mode: DaoHomeMode;
  /** Config + agents root: legacy → the `.dao` dir; home → `~/.swarm-dao/<id>` (shared across branches). */
  projectRoot: string;
  /** state.json / decisions/ / audit root: legacy → the `.dao` dir; home → `<projectRoot>/branches/<branchId>`. */
  stateRoot: string;
  /** Branch/worktree state dir name; null in legacy mode. */
  branchId: string | null;
}

export interface ResolveDaoLayoutOptions {
  /** Create `project.json` and run the passive GC sweep (default true). Read-only callers pass false. */
  ensure?: boolean;
  /** Environment override (tests); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Root of the DAO home: `SWARM_DAO_HOME` override, else `~/.swarm-dao`. */
export function daoHomeBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SWARM_DAO_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".swarm-dao");
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Realpath-resolved repo root + basename, or null outside a git repo.
 *  Memoized per cwd: the identity of a checkout never changes within a
 *  process, and the hot open() path must not re-pay the git execs (the
 *  benchmark gate caught exactly that — ADR-007 follow-up). */
const identityCache = new Map<string, Promise<{ repoRoot: string; repoName: string } | null>>();

/**
 * Cheap git-ness probe without spawning git: walk up from `cwd` looking for
 * a `.git` entry (directory, or file for linked worktrees/submodules). The
 * subprocess probe on throwaway non-git dirs dominated open() on the
 * benchmark runner (PR #205 gate).
 */
function hasGitWorkTree(cwd: string): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      if (existsSync(path.join(dir, ".git"))) return true;
    } catch {
      return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

async function resolveRepoIdentityUncached(cwd: string): Promise<{ repoRoot: string; repoName: string } | null> {
  // No `.git` anywhere up the tree → not a repo, no git subprocess at all.
  if (!hasGitWorkTree(cwd)) return null;
  let commonDir = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (commonDir === null) {
    // git < 2.31: --git-dir may be relative to cwd.
    const fallback = await git(cwd, "rev-parse", "--git-dir");
    if (fallback === null) return null;
    commonDir = path.resolve(cwd, fallback);
  }
  const repoRoot = await fs.realpath(path.dirname(commonDir));
  return { repoRoot, repoName: path.basename(repoRoot) };
}

function resolveRepoIdentity(cwd: string): Promise<{ repoRoot: string; repoName: string } | null> {
  const key = path.resolve(cwd);
  let pending = identityCache.get(key);
  if (pending === undefined) {
    pending = resolveRepoIdentityUncached(key);
    identityCache.set(key, pending);
    if (identityCache.size > 64) {
      // Bounded: long-lived hosts visiting many workspaces stay flat.
      const oldest = identityCache.keys().next().value;
      if (oldest !== undefined) identityCache.delete(oldest);
    }
  }
  return pending;
}

async function resolveBranchId(cwd: string): Promise<string> {
  const branch = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const headSha = await git(cwd, "rev-parse", "HEAD");
  return branchDirName(branch, headSha);
}

/** Live state dir ids: every local branch plus every worktree HEAD (detached included). */
async function collectLiveIds(cwd: string): Promise<Set<string>> {
  const live = new Set<string>();
  const refs = await git(cwd, "for-each-ref", "refs/heads", "--format=%(refname:short)");
  if (refs !== null) {
    for (const branch of refs.split("\n")) {
      if (branch.length > 0) live.add(branchDirName(branch, null));
    }
  }
  const worktrees = await git(cwd, "worktree", "list", "--porcelain");
  if (worktrees !== null) {
    for (const line of worktrees.split("\n")) {
      if (line.startsWith("HEAD ")) live.add(branchDirName(null, line.slice(5).trim()));
    }
  }
  return live;
}

export interface ProjectManifest {
  schemaVersion: 1;
  projectId: string;
  /** Realpath of the owning repo — the GC guard (ADR-007 §5). */
  repoPath: string;
  storageMode: "home" | "repo";
  createdAt: string;
}

/** Write-once manifest; self-heals (rewrites) when unreadable. Plain
 *  tmp+rename instead of persistence.writeAtomic to avoid an import cycle. */
async function readProjectManifest(projectRoot: string): Promise<ProjectManifest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(projectRoot, "project.json"), "utf-8")) as ProjectManifest;
    if (parsed?.schemaVersion === 1 && typeof parsed.repoPath === "string" && typeof parsed.projectId === "string") {
      return parsed;
    }
  } catch {
    /* absent or malformed */
  }
  return null;
}

async function ensureProjectManifest(
  projectRoot: string,
  projectId: string,
  repoPath: string,
): Promise<ProjectManifest> {
  const existing = await readProjectManifest(projectRoot);
  if (existing) return existing;
  const manifest: ProjectManifest = {
    schemaVersion: 1,
    projectId,
    repoPath,
    storageMode: "home",
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(projectRoot, { recursive: true });
  const manifestPath = path.join(projectRoot, "project.json");
  const tmpPath = `${manifestPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, manifestPath);
  return manifest;
}

async function sweepStaleBranches(
  projectRoot: string,
  liveIds: ReadonlySet<string>,
  keepId: string | null,
  dryRun: boolean,
): Promise<string[]> {
  const branchesDir = path.join(projectRoot, "branches");
  let present: string[];
  try {
    present = await fs.readdir(branchesDir);
  } catch {
    return [];
  }
  const directories: string[] = [];
  for (const entry of present) {
    const stats = await fs.stat(path.join(branchesDir, entry)).catch(() => null);
    if (stats?.isDirectory()) directories.push(entry);
  }
  const stale = planGcDirs(directories, liveIds, keepId);
  for (const dir of stale) {
    const target = path.join(branchesDir, dir);
    if (dryRun) {
      logger.info(`🗑 GC (dry-run): would remove ${target}`);
      continue;
    }
    await fs.rm(target, { recursive: true, force: true });
    logger.info(`🗑 GC: removed DAO state of deleted branch "${dir}" (${target})`);
  }
  return stale.map((dir) => path.join(branchesDir, dir));
}

/**
 * Evidence-only entries a home-mode project may accumulate under
 * `<cwd>/.dao` (the pi/mcp graph, product, and improvement tools default
 * their evidence root there). Their presence alone must never flip the
 * project back to legacy mode (Copilot review, PR #205).
 */
const EVIDENCE_ONLY_ENTRIES = new Set(["graph-runs", "improvement-cycles", "improvement-series", "product-loops"]);

/**
 * True when `<root>` holds real DAO state: any entry that is not a bare
 * evidence directory (state.json, config.json, decisions/, …). A legacy
 * `.dao` keeps its project on legacy storage; an evidence-only or absent
 * directory does not relocate a home-mode project back into the repo.
 */
async function isLegacyDaoRoot(root: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return false;
  }
  return entries.some((entry) => !EVIDENCE_ONLY_ENTRIES.has(entry));
}

/**
 * Resolve the DAO layout for `cwd` (ADR-007 §1). Home mode additionally
 * ensures `project.json` and runs the passive GC sweep unless
 * `options.ensure === false` — read-only callers (status/doctor/next) must
 * not create state or delete anything as a side effect.
 */
export async function resolveDaoLayout(cwd: string, options: ResolveDaoLayoutOptions = {}): Promise<DaoLayout> {
  const ensure = options.ensure ?? true;
  const legacyRoot = path.join(cwd, ".dao");
  // Legacy detection by content, not bare existence: an evidence-only `.dao`
  // must not flip a home-mode project (ADR-007 §1). Pure fs, no git exec.
  if (await isLegacyDaoRoot(legacyRoot)) {
    return { mode: "legacy", projectRoot: legacyRoot, stateRoot: legacyRoot, branchId: null };
  }
  const identity = await resolveRepoIdentity(cwd);
  if (identity === null) {
    // Fail closed: home mode needs a git-derived project identity.
    return { mode: "legacy", projectRoot: legacyRoot, stateRoot: legacyRoot, branchId: null };
  }

  const projectId = deriveProjectId(identity.repoRoot, identity.repoName);
  const projectRoot = path.join(daoHomeBase(options.env), projectId);
  const branchId = await resolveBranchId(cwd);
  const stateRoot = path.join(projectRoot, "branches", branchId);
  if (!ensure) return { mode: "home", projectRoot, stateRoot, branchId };

  const manifest = await ensureProjectManifest(projectRoot, projectId, identity.repoRoot);
  // Passive GC (ADR-007 §5) — fail-soft, guarded by the repoPath match.
  try {
    if (manifest.repoPath !== identity.repoRoot) {
      logger.warn(`⚠ DAO home ${projectRoot} belongs to ${manifest.repoPath} — skipping GC for ${identity.repoRoot}`);
    } else {
      const liveIds = await collectLiveIds(cwd);
      liveIds.add(branchId);
      await sweepStaleBranches(projectRoot, liveIds, branchId, false);
    }
  } catch (error) {
    logger.warn(`⚠ DAO home GC skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { mode: "home", projectRoot, stateRoot, branchId };
}

export interface GcResult {
  mode: DaoHomeMode;
  projectRoot: string | null;
  removed: string[];
}

/** Explicit GC sweep behind `swarm-dao gc [--dry-run]` (ADR-007 §5).
 *  Resolves without the passive sweep: `--dry-run` reports exactly what
 *  would be removed, and the explicit run owns its own deletions. */
export async function gcDaoHome(cwd: string, options: { dryRun?: boolean } = {}): Promise<GcResult> {
  const layout = await resolveDaoLayout(cwd, { ensure: false });
  if (layout.mode !== "home") return { mode: layout.mode, projectRoot: null, removed: [] };
  const manifest = await readProjectManifest(layout.projectRoot);
  const identity = await resolveRepoIdentity(cwd);
  // Same repoPath guard as the passive sweep (ADR-007 §5).
  if (manifest === null || identity === null || manifest.repoPath !== identity.repoRoot) {
    return { mode: layout.mode, projectRoot: layout.projectRoot, removed: [] };
  }
  const liveIds = await collectLiveIds(cwd);
  liveIds.add(layout.branchId ?? "");
  const removed = await sweepStaleBranches(layout.projectRoot, liveIds, layout.branchId, options.dryRun === true);
  return { mode: layout.mode, projectRoot: layout.projectRoot, removed };
}

/**
 * Config file path for a DAO dir (ADR-007 §3): config is shared at the
 * project root while `dir` may be the branch state dir
 * (`<projectRoot>/branches/<id>` — two levels below the manifest).
 * Precedence: an existing `<dir>/config.json` wins; otherwise walk up (max
 * 3 levels) to the closest dir holding `project.json` and use its config;
 * fall back to `<dir>/config.json` (legacy layout, also the write location
 * for a fresh config).
 */
export async function resolveConfigFilePath(dir: string, configFile = "config.json"): Promise<string> {
  const local = path.join(dir, configFile);
  if (await pathExists(local)) return local;
  let current = dir;
  for (let depth = 0; depth < 3; depth++) {
    if (await pathExists(path.join(current, "project.json"))) return path.join(current, configFile);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return local;
}
