import { describe, expect, it } from "bun:test";
import {
  configureGitHub,
  getGitHubConfig,
  ghBranchNameFor,
  isGitHubEnabled,
  isIssueSyncEnabled,
} from "../src/integrations/github.js";
import type { Proposal } from "../src/types/index.js";

describe("integrations/github.ts", () => {
  it("configures and computes branch names", () => {
    configureGitHub({ enabled: true, owner: "o", repo: "r" });
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

  it("stores no credentials: enablement depends only on owner/repo/enabled", () => {
    configureGitHub({ enabled: true, owner: "o", repo: "r" });
    expect(getGitHubConfig()).not.toHaveProperty("token");
    expect(isGitHubEnabled()).toBe(true);

    configureGitHub({ enabled: false });
    expect(isGitHubEnabled()).toBe(false);
  });

  it("gates issue sync behind the issues opt-in", () => {
    configureGitHub({ enabled: true, owner: "o", repo: "r" });
    expect(isIssueSyncEnabled()).toBe(false);

    configureGitHub({ issues: true });
    expect(isIssueSyncEnabled()).toBe(true);

    configureGitHub({ enabled: false });
    expect(isIssueSyncEnabled()).toBe(false);
  });
});
