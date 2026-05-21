import { describe, expect, it, mock, beforeEach } from "bun:test";
import { ghCreateBranch, ghCreatePullRequest, configureGitHub } from "../src/integrations/github.js";
import { glCreateBranch, glCreateMergeRequest, configureGitLab } from "../src/integrations/gitlab.js";
import { bbCreateBranch, bbCreatePullRequest, configureBitbucket } from "../src/integrations/bitbucket.js";
import type { Proposal } from "../src/types/index.js";

describe("Integration Error Handling", () => {
  const proposal: Proposal = {
    id: 1,
    title: "Test Proposal",
    type: "product-feature",
    description: "Test description",
    proposedBy: "user",
    status: "open",
    votes: [],
    agentOutputs: [],
    createdAt: new Date().toISOString(),
  };

  describe("GitHub", () => {
    beforeEach(() => {
      configureGitHub({
        enabled: true,
        token: "test-token",
        owner: "test-owner",
        repo: "test-repo",
      });
    });

    it("ghCreateBranch throws error when API fails", async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 404,
        })
      ) as any;

      expect(ghCreateBranch("test-branch")).rejects.toThrow("Failed to get ref for main: 404");
    });

    it("ghCreatePullRequest throws error when API fails", async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 400,
        })
      ) as any;

      expect(ghCreatePullRequest(proposal, { headBranch: "test-branch" })).rejects.toThrow("Failed to create PR: 400");
    });
  });

  describe("GitLab", () => {
    beforeEach(() => {
      configureGitLab({
        enabled: true,
        token: "test-token",
        projectId: "test-project",
      });
    });

    it("glCreateBranch throws error when API fails", async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 500,
        })
      ) as any;

      expect(glCreateBranch("test-branch")).rejects.toThrow("Failed to create branch: 500");
    });

    it("glCreateMergeRequest throws error when API fails", async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 403,
        })
      ) as any;

      expect(glCreateMergeRequest(proposal, { sourceBranch: "test-branch" })).rejects.toThrow("Failed to create MR: 403");
    });
  });

  describe("Bitbucket", () => {
    beforeEach(() => {
      configureBitbucket({
        enabled: true,
        token: "test-token",
        username: "test-user",
        workspace: "test-workspace",
        repo: "test-repo",
      });
    });

    it("bbCreateBranch throws error when API fails", async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 401,
        })
      ) as any;

      expect(bbCreateBranch("test-branch")).rejects.toThrow("Failed to get ref: 401");
    });

    it("bbCreatePullRequest throws error when API fails", async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 404,
        })
      ) as any;

      expect(bbCreatePullRequest(proposal, { sourceBranch: "test-branch" })).rejects.toThrow("Failed to create PR: 404");
    });
  });
});
