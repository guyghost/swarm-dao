import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrRunner } from "@guyghost/swarm-dao-herdr-adapter";
import { ensureSeriesWorktree, seriesBranchName, seriesWorktreePath } from "../src/worktree.js";

/** Fake git runner: fails rev-parse (branch missing) and succeeds worktree add. */
const fakeGit = (
  commands: string[],
  overrides: Record<string, { stdout: string; stderr: string; exitCode: number }> = {},
) =>
  ({
    exec: async (command: string) => {
      commands.push(command);
      for (const [prefix, result] of Object.entries(overrides)) {
        if (command.startsWith(prefix)) return result;
      }
      if (command.startsWith("git rev-parse")) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: "Preparing worktree", stderr: "", exitCode: 0 };
    },
  }) satisfies HerdrRunner;

describe("ensureSeriesWorktree", () => {
  const tmpRepo = async (): Promise<string> => mkdtemp(join(tmpdir(), "swarm-worktree-"));

  it("creates a new branch and worktree when neither exists", async () => {
    const repo = await tmpRepo();
    const commands: string[] = [];
    try {
      const handle = await ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner: fakeGit(commands) });
      expect(handle.created).toBe(true);
      expect(handle.branch).toBe("dao/loop/s-1");
      expect(handle.path).toBe(seriesWorktreePath(repo, "s-1"));
      // Stale registrations are pruned before the branch check.
      expect(commands[0]).toBe("git worktree prune");
      expect(commands[1]).toBe("git rev-parse --verify --quiet refs/heads/dao/loop/s-1");
      expect(commands[2]).toBe(`git worktree add -b dao/loop/s-1 '${join(repo, ".dao/worktrees/s-1")}'`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reuses an existing branch when the worktree was removed", async () => {
    const repo = await tmpRepo();
    const commands: string[] = [];
    try {
      const handle = await ensureSeriesWorktree({
        repoDir: repo,
        seriesId: "s-1",
        runner: fakeGit(commands, {
          "git rev-parse": { stdout: "abc123 refs/heads/dao/loop/s-1\n", stderr: "", exitCode: 0 },
        }),
      });
      expect(handle.created).toBe(true);
      expect(commands[2]).not.toContain("-b");
      expect(commands[2]).toContain(`git worktree add '${join(repo, ".dao/worktrees/s-1")}' dao/loop/s-1`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reuses an already checked-out worktree without any git call", async () => {
    const repo = await tmpRepo();
    const commands: string[] = [];
    try {
      const worktree = seriesWorktreePath(repo, "s-1");
      await mkdir(worktree, { recursive: true });
      // A worktree's `.git` is a FILE pointing at the admin area.
      await writeFile(join(worktree, ".git"), "gitdir: /repo/.git/worktrees/s-1\n", "utf8");
      const handle = await ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner: fakeGit(commands) });
      expect(handle.created).toBe(false);
      expect(commands).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses a non-worktree directory at the worktree path", async () => {
    const repo = await tmpRepo();
    try {
      await mkdir(seriesWorktreePath(repo, "s-1"), { recursive: true });
      await expect(ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner: fakeGit([]) })).rejects.toThrow(
        /not a git worktree/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("propagates git worktree add failures", async () => {
    const repo = await tmpRepo();
    try {
      const runner = fakeGit([], {
        "git worktree add": { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 },
      });
      await expect(ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner })).rejects.toThrow(
        /git worktree add failed: fatal: not a git repository/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects unsafe series ids before any filesystem or git access", async () => {
    await expect(
      ensureSeriesWorktree({ repoDir: "/repo", seriesId: "../escape", runner: fakeGit([]) }),
    ).rejects.toThrow(/safe non-empty filesystem identifier/);
    expect(seriesBranchName("s-1")).toBe("dao/loop/s-1");
  });

  it("syncs the gitignored .dao/improvement.json into the worktree (create and reuse)", async () => {
    const repo = await tmpRepo();
    try {
      await mkdir(join(repo, ".dao"), { recursive: true });
      await writeFile(join(repo, ".dao/improvement.json"), '{"anchorCommands":{}}', "utf8");

      // The fake runner does not create the directory on disk; prepare it the
      // way `git worktree add` would (checkout with a .git file marker).
      const worktree = seriesWorktreePath(repo, "s-1");
      const runner: HerdrRunner = {
        exec: async (command: string) => {
          if (command.startsWith("git rev-parse")) return { stdout: "", stderr: "", exitCode: 1 };
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, ".git"), "gitdir: /repo/.git/worktrees/s-1\n", "utf8");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      };

      await ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner });
      expect(await readFile(join(worktree, ".dao/improvement.json"), "utf8")).toBe('{"anchorCommands":{}}');

      // Reuse also re-syncs (config may have changed between cycles).
      await writeFile(join(repo, ".dao/improvement.json"), '{"anchorCommands":{},"sandbox":{}}', "utf8");
      const reused = await ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner });
      expect(reused.created).toBe(false);
      expect(await readFile(join(worktree, ".dao/improvement.json"), "utf8")).toContain("sandbox");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("ensureSeriesWorktree — dependency installation (dogfood-003 c7 finding)", () => {
  it("installs the frozen lockfile when the worktree is a bun project (create path)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "swarm-worktree-install-"));
    const commands: string[] = [];
    try {
      const worktreePath = seriesWorktreePath(repo, "s-1");
      // Simulate a carved worktree containing a bun manifest (reuse path).
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, ".git"), "gitdir: ../../.git/worktrees/s-1\n", "utf8");
      await writeFile(join(worktreePath, "package.json"), "{}", "utf8");

      const handle = await ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner: fakeGit(commands) });
      expect(handle.created).toBe(false);
      expect(commands).toContain("bun install --frozen-lockfile");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("skips installation for non-bun worktrees", async () => {
    const repo = await mkdtemp(join(tmpdir(), "swarm-worktree-nobun-"));
    const commands: string[] = [];
    try {
      const worktreePath = seriesWorktreePath(repo, "s-1");
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, ".git"), "gitdir: ../../.git/worktrees/s-1\n", "utf8");

      await ensureSeriesWorktree({ repoDir: repo, seriesId: "s-1", runner: fakeGit(commands) });
      expect(commands.some((c) => c.startsWith("bun install"))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
