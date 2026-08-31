import { describe, expect, test } from "bun:test";
import type { Proposal } from "@guyghost/swarm-dao-core";
import { GitWorkspace } from "../src/adapters/git-workspace.js";
import type { CommandRunnerPort } from "../src/ports/host.js";
import { createInitialState } from "../src/types/index.js";

function proposal(id: number, title: string): Proposal {
  const base = {
    id,
    title,
    type: "product-feature" as const,
    description: "d",
    proposedBy: "t",
    status: "controlled" as const,
    votes: [],
    agentOutputs: [],
  };
  return { ...base, ...createInitialState("/tmp/.dao"), id } as unknown as Proposal;
}

type ExecCall = { command: string; options?: { cwd?: string; timeout?: number } };

function recordingRunner(results: Array<{ stdout?: string; stderr?: string; exitCode: number }>): {
  runner: CommandRunnerPort;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  let index = 0;
  return {
    calls,
    runner: {
      exec: async (command, options) => {
        calls.push({ command, options });
        const result = results[Math.min(index++, results.length - 1)];
        if (!result) throw new Error("unexpected exec call");
        return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode };
      },
    },
  };
}

const NOT_A_WORKTREE = [{ exitCode: 128, stderr: "fatal: cannot change to '.dao/worktrees/x': No such file" }];

describe("GitWorkspace", () => {
  test("creates the worktree with a new branch from the repository root", async () => {
    const { runner, calls } = recordingRunner([...NOT_A_WORKTREE, { exitCode: 0 }]);
    const workspace = new GitWorkspace({ runner, repositoryRoot: "/repo", isolation: "worktree" });

    const result = await workspace.prepare(proposal(7, "Add Dark Mode"));
    expect(result).toEqual({
      ok: true,
      branch: "dao/7-add-dark-mode",
      path: "/repo/.dao/worktrees/7-add-dark-mode",
    });
    expect(calls[1]?.command).toBe("git worktree add -b dao/7-add-dark-mode .dao/worktrees/7-add-dark-mode");
    expect(calls[1]?.options?.cwd).toBe("/repo");
  });

  test("passes the base branch when configured", async () => {
    const { runner, calls } = recordingRunner([...NOT_A_WORKTREE, { exitCode: 0 }]);
    const workspace = new GitWorkspace({
      runner,
      repositoryRoot: "/repo",
      isolation: "worktree",
      baseBranch: "develop",
    });

    await workspace.prepare(proposal(1, "Fix Login"));
    expect(calls[1]?.command).toBe("git worktree add -b dao/1-fix-login .dao/worktrees/1-fix-login develop");
  });

  test("is idempotent when the worktree already sits on the branch", async () => {
    const { runner, calls } = recordingRunner([{ exitCode: 0, stdout: "dao/3-retry-me\n" }]);
    const workspace = new GitWorkspace({ runner, repositoryRoot: "/repo", isolation: "worktree" });

    const result = await workspace.prepare(proposal(3, "Retry Me"));
    expect(result).toEqual({ ok: true, branch: "dao/3-retry-me", path: "/repo/.dao/worktrees/3-retry-me" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("git -C .dao/worktrees/3-retry-me rev-parse --abbrev-ref HEAD");
  });

  test("falls back to attaching when only the branch already exists", async () => {
    const { runner, calls } = recordingRunner([
      ...NOT_A_WORKTREE,
      { exitCode: 1, stderr: "fatal: a branch named 'dao/1-fix-login' already exists" },
      { exitCode: 0 },
    ]);
    const workspace = new GitWorkspace({ runner, repositoryRoot: "/repo", isolation: "worktree" });

    const result = await workspace.prepare(proposal(1, "Fix Login"));
    expect(result.ok).toBe(true);
    expect(calls[2]?.command).toBe("git worktree add .dao/worktrees/1-fix-login dao/1-fix-login");
  });

  test("returns the git error when creation fails", async () => {
    const { runner } = recordingRunner([...NOT_A_WORKTREE, { exitCode: 128, stderr: "fatal: not a git repository" }]);
    const workspace = new GitWorkspace({ runner, repositoryRoot: "/repo", isolation: "worktree" });

    const result = await workspace.prepare(proposal(2, "Anything"));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("not a git repository") });
  });

  test("isolation none is a no-op that still reports the branch", async () => {
    const { runner, calls } = recordingRunner([{ exitCode: 0 }]);
    const workspace = new GitWorkspace({ runner, repositoryRoot: "/repo", isolation: "none" });

    const result = await workspace.prepare(proposal(3, "Plain"));
    expect(result).toEqual({ ok: true, branch: "dao/3-plain", path: null });
    expect(calls).toHaveLength(0);
  });

  test("unsafe configuration fails closed before any command runs", async () => {
    for (const options of [
      { worktreeRoot: "/etc" },
      { worktreeRoot: ".." },
      { worktreeRoot: "a;touch-pwned" },
      { baseBranch: "main; rm -rf /" },
      { baseBranch: "-b evil" },
    ]) {
      const { runner, calls } = recordingRunner([{ exitCode: 0 }]);
      const workspace = new GitWorkspace({
        runner,
        repositoryRoot: "/repo",
        isolation: "worktree",
        ...options,
      });
      const result = await workspace.prepare(proposal(4, "Anything"));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain("invalid execution isolation config");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("GitWorkspace — sandbox mode (ADR-003)", () => {
  test("probes the runtime before provisioning and fails honestly when it is missing", async () => {
    const { runner, calls } = recordingRunner([
      { stdout: "", stderr: "command not found", exitCode: 127 }, // container --version probe fails
    ]);
    const workspace = new GitWorkspace({
      runner,
      repositoryRoot: "/repo",
      isolation: "sandbox",
      sandbox: { runtime: "container", image: "node:22" },
    });
    const result = await workspace.prepare(proposal(7, "Sandbox it"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("sandbox runtime 'container' is not available");
    expect(calls[0]?.command).toBe("container --version");
    expect(calls.length).toBe(1); // no git effect ran
  });

  test("provisions the worktree after a passing runtime probe", async () => {
    const { runner, calls } = recordingRunner([
      { stdout: "container CLI version 1.3.0", stderr: "", exitCode: 0 }, // probe
      { stdout: "", stderr: "", exitCode: 1 }, // rev-parse: no existing worktree
      { stdout: "", stderr: "", exitCode: 0 }, // worktree add
    ]);
    const workspace = new GitWorkspace({
      runner,
      repositoryRoot: "/repo",
      isolation: "sandbox",
      worktreeRoot: ".dao/worktrees",
      sandbox: { runtime: "container", image: "node:22" },
    });
    const result = await workspace.prepare(proposal(7, "Sandbox it"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.branch).toBe("dao/7-sandbox-it");
      expect(result.path).toBe("/repo/.dao/worktrees/7-sandbox-it");
    }
    expect(calls[2]?.command).toContain("git worktree add -b dao/7-sandbox-it");
  });
});
