import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDaoLayout } from "../src/adapters/dao-home/dao-home.js";
import { branchDirName } from "../src/adapters/dao-home/naming.js";
import { withFileLock } from "../src/adapters/persistence/file-dao-state.repository.js";

const gitBinary = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const source = new URL("../src/adapters/dao-home/dao-home.ts", import.meta.url).href;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-storage-regression-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await fs.mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync(gitBinary, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
    });
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-m", "init");
  const env = { ...process.env, SWARM_DAO_HOME: home };
  const layout = await resolveDaoLayout(repo, { env });
  return { root, repo, env, layout, git };
}

describe("DAO storage safety", () => {
  it("separates punctuation, case, long names and detached-looking branch names", () => {
    const names = [
      "feature/foo",
      "feature-foo",
      "Feature/foo",
      `${"a".repeat(90)}x`,
      `${"a".repeat(90)}y`,
      "detached-12345678",
    ];
    const ids = names.map((name) => branchDirName(name, null));
    expect(new Set(ids).size).toBe(names.length);
    expect(ids).not.toContain(branchDirName(null, "1234567890"));
  });

  for (const command of ["for-each-ref", "worktree"]) {
    it(`preserves all data when git ${command} fails`, async () => {
      const f = await fixture();
      try {
        f.git("branch", "other");
        const state = path.join(f.layout.projectRoot, "branches", branchDirName("other", null));
        await fs.mkdir(state, { recursive: true });
        await fs.writeFile(path.join(state, "state.json"), "preserve-me");
        const bin = path.join(f.root, "bin");
        await fs.mkdir(bin);
        await fs.writeFile(
          path.join(bin, "git"),
          `#!/bin/sh\nif [ "$1" = "${command}" ]; then exit 1; fi\nexec '${gitBinary.replaceAll("'", "'\\''")}' "$@"\n`,
          { mode: 0o755 },
        );
        execFileSync(
          process.execPath,
          [
            "--eval",
            `import { resolveDaoLayout, gcDaoHome } from ${JSON.stringify(source)}; await resolveDaoLayout(process.cwd()); let refused = false; try { await gcDaoHome(process.cwd()); } catch { refused = true; } if (!refused) throw new Error("GC must refuse incomplete inventory");`,
          ],
          {
            cwd: f.repo,
            env: { ...f.env, PATH: `${bin}:${process.env.PATH}` },
            stdio: "pipe",
          },
        );
        expect(await fs.readFile(path.join(state, "state.json"), "utf8")).toBe("preserve-me");
      } finally {
        await fs.rm(f.root, { recursive: true, force: true });
      }
    });
  }

  it("reads and migrates unambiguous legacy storage without losing data", async () => {
    const f = await fixture();
    try {
      const legacy = path.join(f.layout.projectRoot, "branches", "main");
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, "state.json"), "preserve-me");
      expect((await resolveDaoLayout(f.repo, { env: f.env, ensure: false })).stateRoot).toBe(legacy);
      const migrated = await resolveDaoLayout(f.repo, { env: f.env });
      expect(migrated.stateRoot).toBe(f.layout.stateRoot);
      expect(await fs.readFile(path.join(migrated.stateRoot, "state.json"), "utf8")).toBe("preserve-me");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses to assign a shared legacy directory to either colliding branch", async () => {
    const f = await fixture();
    try {
      f.git("checkout", "-b", "feature/foo");
      f.git("branch", "feature-foo");
      const legacy = path.join(f.layout.projectRoot, "branches", "feature-foo");
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, "state.json"), "preserve-me");
      await expect(resolveDaoLayout(f.repo, { env: f.env })).rejects.toThrow("Ambiguous legacy DAO state");
      expect(await fs.readFile(path.join(legacy, "state.json"), "utf8")).toBe("preserve-me");
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("does not steal a newly created lock while its payload is incomplete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-lock-regression-"));
    const lock = path.join(root, "state.lock");
    let entered = false;
    let waiter: Promise<void> | undefined;
    try {
      await fs.writeFile(lock, "");
      waiter = withFileLock(root, async () => {
        entered = true;
      });
      await pause(100);
      expect(entered).toBe(false);
      await fs.unlink(lock);
      await waiter;
      expect(entered).toBe(true);
    } finally {
      await fs.rm(lock, { force: true });
      await waiter;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned mtime lease without a legacy timestamp", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-abandoned-lock-"));
    try {
      const lock = path.join(root, "state.lock");
      await fs.writeFile(lock, JSON.stringify({ token: "abandoned", heartbeat: "mtime" }));
      const old = new Date(Date.now() - 60000);
      await fs.utimes(lock, old, old);
      await withFileLock(root, async (lease) => {
        await lease.assertOwned();
        expect(JSON.parse(await fs.readFile(lock, "utf8")).token).not.toBe("abandoned");
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes a lease without rewriting its JSON payload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-heartbeat-regression-"));
    try {
      await withFileLock(root, async (lease) => {
        const lock = path.join(root, "state.lock");
        const initial = await fs.readFile(lock, "utf8");
        expect(JSON.parse(initial).ts).toBeUndefined();
        const before = (await fs.stat(lock)).mtimeMs;
        await pause(5300);
        expect(await fs.readFile(lock, "utf8")).toBe(initial);
        expect((await fs.stat(lock)).mtimeMs).toBeGreaterThan(before);
        await lease.assertOwned();
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10000);
});
