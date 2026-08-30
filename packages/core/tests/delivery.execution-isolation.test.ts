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
});
