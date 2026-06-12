import { describe, expect, it } from "bun:test";
import { configureGitLab, glBranchNameFor, isGitLabEnabled } from "../src/integrations/gitlab.js";
import type { Proposal } from "../src/types/index.js";

describe("integrations/gitlab.ts", () => {
  it("configures integration and computes branch name", () => {
    configureGitLab({
      enabled: true,
      token: "t",
      projectId: "p",
    });
    const proposal: Proposal = {
      id: 18,
      title: "RBAC support",
      type: "security-change",
      description: "desc",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    expect(isGitLabEnabled()).toBe(true);
    expect(glBranchNameFor(proposal)).toContain("dao/18-rbac-support");
  });

  it("uses DAO_GITLAB_TOKEN when configured token is redacted", () => {
    const previous = process.env.DAO_GITLAB_TOKEN;
    delete process.env.DAO_GITLAB_TOKEN;

    configureGitLab({
      enabled: true,
      token: "[REDACTED]",
      projectId: "p",
    });
    expect(isGitLabEnabled()).toBe(false);

    process.env.DAO_GITLAB_TOKEN = "env-token";
    expect(isGitLabEnabled()).toBe(true);

    if (previous === undefined) {
      delete process.env.DAO_GITLAB_TOKEN;
    } else {
      process.env.DAO_GITLAB_TOKEN = previous;
    }
  });
});
