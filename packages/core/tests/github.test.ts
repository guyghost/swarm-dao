import { describe, expect, it } from "bun:test";
import { configureGitHub, ghBranchNameFor, isGitHubEnabled } from "../src/integrations/github.js";
import type { Proposal } from "../src/types/index.js";

describe("integrations/github.ts", () => {
  it("configures and computes branch names", () => {
    configureGitHub({ enabled: true, token: "t", owner: "o", repo: "r" });
    const proposal: Proposal = {
      id: 12,
      title: "Add Dark Mode",
      type: "product-feature",
      description: "desc",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    expect(isGitHubEnabled()).toBe(true);
    expect(ghBranchNameFor(proposal)).toContain("dao/12-add-dark-mode");
  });
});
