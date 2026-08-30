import { describe, expect, test } from "bun:test";
import { createInitialState, type Proposal } from "@guyghost/swarm-dao-core";
import { planExecutionIsolation } from "../src/delivery/execution-isolation.js";

function proposal(id: number, title: string): Proposal {
  const state = createInitialState("/tmp/.dao");
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
  return { ...base, ...state, id } as unknown as Proposal;
}

describe("planExecutionIsolation", () => {
  test("none mode (default) plans no isolation", () => {
    const plan = planExecutionIsolation(proposal(1, "Add dark mode"));
    expect(plan).toEqual({ mode: "none" });
  });

  test("worktree mode derives branch and path deterministically", () => {
    const plan = planExecutionIsolation(proposal(7, "Add Dark Mode!"), { isolation: "worktree" });
    expect(plan).toEqual({
      mode: "worktree",
      branch: "dao/7-add-dark-mode",
      path: ".dao/worktrees/7-add-dark-mode",
      baseBranch: null,
    });
  });

  test("custom root and base branch are honored", () => {
    const plan = planExecutionIsolation(proposal(2, "Fix Login"), {
      isolation: "worktree",
      worktreeRoot: ".worktrees",
      baseBranch: "develop",
    });
    expect(plan).toEqual({
      mode: "worktree",
      branch: "dao/2-fix-login",
      path: ".worktrees/2-fix-login",
      baseBranch: "develop",
    });
  });

  test("titles collapse to stable slugs", () => {
    const a = planExecutionIsolation(proposal(3, "  Add -- CRAZY  spacing!!  "), { isolation: "worktree" });
    expect(a).toMatchObject({ branch: "dao/3-add-crazy-spacing", path: ".dao/worktrees/3-add-crazy-spacing" });
  });

  test("empty titles still yield a valid slug", () => {
    const plan = planExecutionIsolation(proposal(4, "!!! ???"), { isolation: "worktree" });
    expect(plan).toMatchObject({ branch: "dao/4-proposal" });
  });

  test("invalid isolation mode fails closed to none", () => {
    const plan = planExecutionIsolation(proposal(5, "x"), { isolation: "bogus" as never });
    expect(plan.mode).toBe("none");
  });

  test("absolute worktree roots are rejected", () => {
    for (const root of ["/etc", "/tmp/worktrees", "/."]) {
      const plan = planExecutionIsolation(proposal(6, "x"), { isolation: "worktree", worktreeRoot: root });
      expect(plan).toMatchObject({ mode: "invalid" });
    }
  });

  test("traversal and dot segments in worktree roots are rejected", () => {
    for (const root of ["..", "../worktrees", "a/../b", ".", "a/./b", "a/..", "a/"]) {
      const plan = planExecutionIsolation(proposal(7, "x"), { isolation: "worktree", worktreeRoot: root });
      expect(plan).toMatchObject({ mode: "invalid" });
    }
  });

  test("shell metacharacters and leading dashes in worktree roots are rejected", () => {
    const roots = [
      "; rm -rf /",
      "a;touch-pwned",
      "a$(id)",
      "a`id`",
      "a|b",
      "a b",
      "-oInject",
      "--global",
      "a\nb",
      "a\\b",
      "*'",
    ];
    for (const root of roots) {
      const plan = planExecutionIsolation(proposal(8, "x"), { isolation: "worktree", worktreeRoot: root });
      expect(plan).toMatchObject({ mode: "invalid" });
    }
  });

  test("unsafe base branches are rejected", () => {
    const branches = [
      "main; rm -rf /",
      "$(id)",
      "`id`",
      "-b evil",
      "..",
      "a/../b",
      "origin/../evil",
      "main..next",
      "main ",
      "",
    ];
    for (const baseBranch of branches) {
      const plan = planExecutionIsolation(proposal(9, "x"), { isolation: "worktree", baseBranch });
      expect(plan).toMatchObject({ mode: "invalid" });
    }
  });

  test("legitimate roots and branch names are accepted", () => {
    const cases: Array<{ worktreeRoot?: string; baseBranch?: string }> = [
      { worktreeRoot: ".dao/worktrees" },
      { worktreeRoot: ".worktrees" },
      { worktreeRoot: "build/worktrees-2" },
      { worktreeRoot: ".dao/worktrees", baseBranch: "main" },
      { worktreeRoot: ".dao/worktrees", baseBranch: "develop" },
      { worktreeRoot: ".dao/worktrees", baseBranch: "release/1.2" },
      { worktreeRoot: ".dao/worktrees", baseBranch: "refs/heads/main" },
      { worktreeRoot: ".dao/worktrees", baseBranch: "user/feature.x" },
    ];
    for (const options of cases) {
      const plan = planExecutionIsolation(proposal(10, "Safe Title"), { isolation: "worktree", ...options });
      expect(plan.mode).toBe("worktree");
    }
  });
});
