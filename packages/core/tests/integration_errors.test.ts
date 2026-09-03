import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bbCreateBranch, bbCreatePullRequest, configureBitbucket } from "../src/integrations/bitbucket.js";
import { configureGitHub, ghCreateBranch, ghCreatePullRequest } from "../src/integrations/github.js";
import { configureGitLab, glCreateBranch, glCreateMergeRequest } from "../src/integrations/gitlab.js";
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
    // The GitHub integration shells out to the `gh` CLI; a fake `gh` on PATH
    // keeps these tests offline and deterministic.
    let fakeBinDir: string;
    let originalPath: string | undefined;

    beforeAll(async () => {
      fakeBinDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-fake-gh-"));
      await fs.writeFile(
        path.join(fakeBinDir, "gh"),
        "#!/bin/sh\necho 'gh: simulated failure (HTTP 500)' >&2\nexit 1\n",
        { mode: 0o755 },
      );
      originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
    });

    afterAll(() => {
      process.env.PATH = originalPath;
      fs.rm(fakeBinDir, { recursive: true, force: true }).catch(() => {});
    });

    beforeEach(() => {
      configureGitHub({
        enabled: true,
        owner: "test-owner",
        repo: "test-repo",
      });
    });

    it("ghCreateBranch throws a descriptive error when gh fails", async () => {
      expect(ghCreateBranch("test-branch")).rejects.toThrow(
        "gh api repos/test-owner/test-repo/git/ref/heads/main failed",
      );
    });

    it("ghCreatePullRequest throws a descriptive error when gh fails", async () => {
      expect(ghCreatePullRequest(proposal, { headBranch: "test-branch" })).rejects.toThrow(
        "gh api repos/test-owner/test-repo/pulls failed",
      );
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
      global.fetch = mock(
        () =>
          Promise.resolve({
            ok: false,
            status: 500,
          }),
        // biome-ignore lint/suspicious/noExplicitAny: test mock for fetch
      ) as any;

      expect(glCreateBranch("test-branch")).rejects.toThrow("Failed to create branch: 500");
    });

    it("glCreateMergeRequest throws error when API fails", async () => {
      global.fetch = mock(
        () =>
          Promise.resolve({
            ok: false,
            status: 403,
          }),
        // biome-ignore lint/suspicious/noExplicitAny: test mock for fetch
      ) as any;

      expect(glCreateMergeRequest(proposal, { sourceBranch: "test-branch" })).rejects.toThrow(
        "Failed to create MR: 403",
      );
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
      global.fetch = mock(
        () =>
          Promise.resolve({
            ok: false,
            status: 401,
          }),
        // biome-ignore lint/suspicious/noExplicitAny: test mock for fetch
      ) as any;

      expect(bbCreateBranch("test-branch")).rejects.toThrow("Failed to get ref: 401");
    });

    it("bbCreatePullRequest throws error when API fails", async () => {
      global.fetch = mock(
        () =>
          Promise.resolve({
            ok: false,
            status: 404,
          }),
        // biome-ignore lint/suspicious/noExplicitAny: test mock for fetch
      ) as any;

      expect(bbCreatePullRequest(proposal, { sourceBranch: "test-branch" })).rejects.toThrow(
        "Failed to create PR: 404",
      );
    });
  });
});
