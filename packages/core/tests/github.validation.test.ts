// GitHub integration input validation (issue #166): owner, repo and
// headBranch are interpolated into `gh api` routes executed with the user's
// credentials — they must satisfy the GitHub slug / git refname charsets
// before any route is built or value persisted.
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGitRef } from "../src/delivery/execution-isolation.js";
import { configureGitHub, ghCreatePullRequest, validateGitHubSlug } from "../src/integrations/github.js";

describe("github input validation (issue #166)", () => {
  beforeEach(() => {
    configureGitHub({ enabled: false, owner: undefined, repo: undefined });
  });

  it("validateGitHubSlug rejects route-manipulating values", () => {
    expect(validateGitHubSlug("owner", "foo/bar")).toMatch(/must match/);
    expect(validateGitHubSlug("repo", "../../etc")).toMatch(/must match/);
    expect(validateGitHubSlug("repo", "a..b")).toMatch(/\.\./);
    expect(validateGitHubSlug("owner", "bad\0null")).toMatch(/must match/);
    expect(validateGitHubSlug("owner", "")).toMatch(/must not be empty/);
    expect(validateGitHubSlug("owner", "x".repeat(101))).toMatch(/too long/);
  });

  it("validateGitHubSlug accepts legitimate names", () => {
    expect(validateGitHubSlug("owner", "acme-corp")).toBeNull();
    expect(validateGitHubSlug("repo", "app.core_v2")).toBeNull();
    expect(validateGitHubSlug("repo", "repo-1.0")).toBeNull();
  });

  it("configureGitHub throws on route-manipulating slugs", () => {
    expect(() => configureGitHub({ owner: "foo/bar", repo: "app" })).toThrow(/Invalid GitHub configuration/);
    expect(() => configureGitHub({ owner: "ok", repo: "app; rm -rf" })).toThrow(/Invalid GitHub configuration/);
    expect(() => configureGitHub({ owner: "ok", repo: "app", defaultBranch: "../x" })).toThrow(
      /Invalid GitHub configuration/,
    );
  });

  it("ghCreatePullRequest refuses an unsafe headBranch before any gh call", async () => {
    configureGitHub({ owner: "acme", repo: "app", enabled: true });
    const proposal = {
      id: 1,
      title: "T",
      type: "technical-change" as const,
      description: "d",
      proposedBy: "t",
      status: "controlled" as const,
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    // No gh binary needed: validation fires before the subprocess spawn.
    await expect(ghCreatePullRequest(proposal, { headBranch: "evil\0branch" })).rejects.toThrow(/headBranch/);
    await expect(ghCreatePullRequest(proposal, { headBranch: "a..b" })).rejects.toThrow(/headBranch/);
    // The valid branch passes validation and reaches the gh subprocess —
    // which must never actually run here: a real `gh api` POST is a network
    // call that raced bun's 5s test timeout on shared CI runners. Pointing
    // PATH at an empty directory makes the spawn fail deterministically with
    // ENOENT, still proving the ref got past validation.
    const realPath = process.env.PATH;
    const emptyBin = await mkdtemp(join(tmpdir(), "no-gh-bin-"));
    process.env.PATH = emptyBin;
    try {
      await expect(ghCreatePullRequest(proposal, { headBranch: "feature/x-1.2" })).rejects.toThrow(
        /gh api|Failed|spawn|ENOENT|timed out|exited/i,
      );
    } finally {
      process.env.PATH = realPath;
      await rm(emptyBin, { recursive: true, force: true });
    }
    configureGitHub({ enabled: false, owner: undefined, repo: undefined });
  });

  it("validateGitRef rejects refs that are not safe refnames", () => {
    expect(validateGitRef("feature/ok")).toBeNull();
    expect(validateGitRef("-leading-dash")).toMatch(/must match/);
    expect(validateGitRef("endswith.lock")).toMatch(/refname/);
    expect(validateGitRef("has space")).toMatch(/must match/);
  });
});
