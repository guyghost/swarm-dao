// ADR-007: External DAO Home — contract tests.
// Covers: project-id derivation, branch dir naming, GC planning (pure),
// resolution precedence (legacy .dao > home), passive GC with its guards,
// and FileDaoStateRepository routing into the home layout.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  branchDirName,
  deriveProjectId,
  FileDaoStateRepository,
  gcDaoHome,
  loadConfig,
  planGcDirs,
  resolveDaoLayout,
} from "@guyghost/swarm-dao-core";

function mkRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `swarm-dao-home-${prefix}-`));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
  }).trim();
}

function initRepo(cwd: string, branch = "main"): void {
  git(cwd, "init", "-b", branch);
  git(cwd, "-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init");
}

describe("ADR-007 naming (pure)", () => {
  it("derives a deterministic, path-unique project id", () => {
    const a = deriveProjectId("/tmp/whatever/swarm-dao", "swarm-dao");
    const b = deriveProjectId("/tmp/other/swarm-dao", "swarm-dao");
    expect(a).toMatch(/^swarm-dao-[0-9a-f]{8}$/);
    expect(a).toBe(deriveProjectId("/tmp/whatever/swarm-dao", "swarm-dao"));
    expect(a).not.toBe(b);
  });

  it("maps a branch to a flat, safe directory name", () => {
    expect(branchDirName("feature/adr-007", null)).toBe("feature-adr-007");
    expect(branchDirName("release/v1.2", null)).toBe("release-v1-2");
    expect(branchDirName(null, "a1b2c3d4e5f6")).toBe("detached-a1b2c3d4");
    expect(branchDirName(null, null)).toBe("default");
  });

  it("plans GC: stale dirs only, never live, never the current one", () => {
    const live = new Set(["main", "feature-x"]);
    expect(planGcDirs(["main", "feature-x", "gone-branch"], live, "main")).toEqual(["gone-branch"]);
    // detached ids are live by sha prefix
    const liveWithDetached = new Set(["main", "detached-a1b2c3d4"]);
    expect(planGcDirs(["detached-a1b2c3d4", "detached-99999999"], liveWithDetached, null)).toEqual([
      "detached-99999999",
    ]);
  });
});

describe("ADR-007 resolution precedence", () => {
  const savedHome = process.env.SWARM_DAO_HOME;
  beforeAll(() => {
    process.env.SWARM_DAO_HOME = "";
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.SWARM_DAO_HOME;
    else process.env.SWARM_DAO_HOME = savedHome;
  });

  it("uses legacy cwd/.dao when it exists, even outside git", async () => {
    const cwd = await mkRoot("legacy");
    try {
      await fs.mkdir(path.join(cwd, ".dao"), { recursive: true });
      const layout = await resolveDaoLayout(cwd);
      expect(layout.mode).toBe("legacy");
      expect(layout.stateRoot).toBe(path.join(cwd, ".dao"));
      expect(layout.projectRoot).toBe(path.join(cwd, ".dao"));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("an evidence-only .dao never flips a git repo out of home mode", async () => {
    const repo = await mkRoot("evidence");
    const home = await mkRoot("evidence-home");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      await fs.mkdir(path.join(repo, ".dao", "graph-runs", "r1"), { recursive: true });
      await fs.writeFile(path.join(repo, ".dao", "graph-runs", "r1", "snapshot.json"), "{}");

      const layout = await resolveDaoLayout(repo);
      expect(layout.mode).toBe("home");
      expect(layout.stateRoot).toContain(path.join("branches", "main"));
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("a .dao holding real state (state.json) keeps a git repo on legacy", async () => {
    const repo = await mkRoot("legacy-git");
    const home = await mkRoot("legacy-git-home");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      await fs.mkdir(path.join(repo, ".dao"), { recursive: true });
      await fs.writeFile(path.join(repo, ".dao", "state.json"), "{}");

      const layout = await resolveDaoLayout(repo);
      expect(layout.mode).toBe("legacy");
      expect(layout.stateRoot).toBe(path.join(repo, ".dao"));
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("non-git projects without home env stay on legacy cwd/.dao", async () => {
    const cwd = await mkRoot("nogit");
    try {
      const layout = await resolveDaoLayout(cwd);
      expect(layout.mode).toBe("legacy");
      expect(layout.stateRoot).toBe(path.join(cwd, ".dao"));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("a git repo resolves to ~/.swarm-dao (or SWARM_DAO_HOME) with per-branch state", async () => {
    const repo = await mkRoot("repo");
    const home = await mkRoot("home");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      const realpath = await fs.realpath(repo);
      const layout = await resolveDaoLayout(repo);
      expect(layout.mode).toBe("home");
      expect(layout.projectRoot).toBe(path.join(home, deriveProjectId(realpath, path.basename(realpath))));
      expect(layout.stateRoot).toBe(path.join(layout.projectRoot, "branches", "main"));

      const project = JSON.parse(await fs.readFile(path.join(layout.projectRoot, "project.json"), "utf-8"));
      expect(project.repoPath).toBe(realpath);
      expect(project.storageMode).toBe("home");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("detached HEAD gets its own dir; a symlinked path maps to the same project", async () => {
    const repo = await mkRoot("detached");
    const home = await mkRoot("home2");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      git(repo, "checkout", "--detach", "HEAD");
      const layout = await resolveDaoLayout(repo);
      const sha = git(repo, "rev-parse", "HEAD");
      expect(layout.stateRoot).toBe(path.join(layout.projectRoot, "branches", `detached-${sha.slice(0, 8)}`));

      // Symlinked path resolves to the same project id (realpath).
      const link = path.join(await mkRoot("link"), "linked");
      await fs.symlink(repo, link);
      try {
        const viaLink = await resolveDaoLayout(link);
        expect(viaLink.projectRoot).toBe(layout.projectRoot);
      } finally {
        await fs.rm(path.dirname(link), { recursive: true, force: true });
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("two clones of the same repo map to different project ids", async () => {
    const repo = await mkRoot("origin");
    const clone = path.join(await mkRoot("clones"), "copy");
    const home = await mkRoot("home3");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      git(repo, "clone", repo, clone);
      const a = await resolveDaoLayout(repo);
      const b = await resolveDaoLayout(clone);
      expect(a.projectRoot).not.toBe(b.projectRoot);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(path.dirname(clone), { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("ADR-007 passive GC", () => {
  const savedHome = process.env.SWARM_DAO_HOME;
  beforeAll(() => {
    process.env.SWARM_DAO_HOME = "";
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.SWARM_DAO_HOME;
    else process.env.SWARM_DAO_HOME = savedHome;
  });

  async function seedStaleBranches(repo: string, projectRoot: string, branchDir: string): Promise<void> {
    const branches = path.join(projectRoot, "branches");
    await fs.mkdir(path.join(branches, "deleted-branch"), { recursive: true });
    await fs.writeFile(path.join(branches, "deleted-branch", "state.json"), "{}");
    await fs.mkdir(path.join(branches, branchDir), { recursive: true });
    void repo;
  }

  it("removes state of deleted branches, keeps live and current", async () => {
    const repo = await mkRoot("gc");
    const home = await mkRoot("gc-home");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      const layout = await resolveDaoLayout(repo); // seeds project.json
      await seedStaleBranches(repo, layout.projectRoot, "main");

      const after = await resolveDaoLayout(repo); // passive GC sweep
      const branches = await fs.readdir(path.join(after.projectRoot, "branches"));
      expect(branches).toContain("main");
      expect(branches).not.toContain("deleted-branch");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("skips GC when project.json.repoPath does not match the current repo", async () => {
    const repo = await mkRoot("gc-guard");
    const home = await mkRoot("gc-guard-home");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      const layout = await resolveDaoLayout(repo);
      const projectPath = path.join(layout.projectRoot, "project.json");
      const project = JSON.parse(await fs.readFile(projectPath, "utf-8"));
      project.repoPath = "/somewhere/else";
      await fs.writeFile(projectPath, JSON.stringify(project));
      await seedStaleBranches(repo, layout.projectRoot, "main");

      await resolveDaoLayout(repo);
      const branches = await fs.readdir(path.join(layout.projectRoot, "branches"));
      expect(branches).toContain("deleted-branch");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("ADR-007 explicit gc command", () => {
  const savedHome = process.env.SWARM_DAO_HOME;
  beforeAll(() => {
    process.env.SWARM_DAO_HOME = "";
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.SWARM_DAO_HOME;
    else process.env.SWARM_DAO_HOME = savedHome;
  });

  it("--dry-run reports the stale dir without deleting it; the real run deletes", async () => {
    const repo = await mkRoot("gcrun");
    const home = await mkRoot("gcrun-home");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      const layout = await resolveDaoLayout(repo); // seeds project.json
      const branches = path.join(layout.projectRoot, "branches");
      await fs.mkdir(path.join(branches, "deleted-branch"), { recursive: true });

      const dry = await gcDaoHome(repo, { dryRun: true });
      expect(dry.removed).toHaveLength(1);
      expect(await fs.readdir(branches)).toContain("deleted-branch");

      const wet = await gcDaoHome(repo);
      expect(wet.removed).toHaveLength(1);
      expect(await fs.readdir(branches)).not.toContain("deleted-branch");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("ADR-007 wiring", () => {
  const savedHome = process.env.SWARM_DAO_HOME;
  beforeAll(() => {
    process.env.SWARM_DAO_HOME = "";
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.SWARM_DAO_HOME;
    else process.env.SWARM_DAO_HOME = savedHome;
  });

  it("routes FileDaoStateRepository state into the branch dir and reads project config", async () => {
    const repo = await mkRoot("wiring");
    const home = await mkRoot("wiring-home");
    process.env.SWARM_DAO_HOME = home;
    try {
      initRepo(repo);
      const repoHandle = await FileDaoStateRepository.open(repo);
      repoHandle.get().initialized = true;
      await repoHandle.persist();

      const layout = await resolveDaoLayout(repo);
      const entries = await fs.readdir(layout.stateRoot);
      expect(entries).toContain("state.json");
      // nothing lands in the repo working tree
      await expect(fs.access(path.join(repo, ".dao"))).rejects.toThrow();
      await expect(fs.access(path.join(repo, "state.json"))).rejects.toThrow();

      // Project-level config is shared: readable from the branch state dir.
      await fs.writeFile(
        path.join(layout.projectRoot, "config.json"),
        JSON.stringify({ mode: "enforce", criticalPaths: ["src/secrets/**"] }),
      );
      const config = await loadConfig(layout.stateRoot);
      expect(config.mode).toBe("enforce");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
