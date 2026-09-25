import { describe, expect, it, mock } from "bun:test";
import {
  bbBranchNameFor,
  bbCreateBranch,
  configureBitbucket,
  isBitbucketEnabled,
} from "../src/integrations/bitbucket.js";
import type { Proposal } from "../src/types/index.js";

describe("integrations/bitbucket.ts", () => {
  it("configures integration and creates branch name", () => {
    configureBitbucket({
      enabled: true,
      token: "t",
      username: "u",
      workspace: "w",
      repo: "r",
    });
    const proposal: Proposal = {
      id: 21,
      title: "Telemetry update",
      type: "technical-change",
      description: "desc",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    expect(isBitbucketEnabled()).toBe(true);
    expect(bbBranchNameFor(proposal)).toContain("dao/21-telemetry-update");
  });

  it("rejects a workspace or repo that could re-route the API path (issue #166 parity)", () => {
    expect(() => configureBitbucket({ workspace: "acme/admin" })).toThrow();
    expect(() => configureBitbucket({ repo: ".." })).toThrow();
    expect(() => configureBitbucket({ workspace: "a b" })).toThrow();
  });

  it("URL-encodes a base branch containing slashes", async () => {
    configureBitbucket({
      enabled: true,
      token: "t",
      username: "u",
      workspace: "acme",
      repo: "app",
    });
    const seen: string[] = [];
    global.fetch = mock((url: string) => {
      seen.push(String(url));
      if (seen.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ target: { hash: "abc123" } }),
        });
      }
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({}) });
      // biome-ignore lint/suspicious/noExplicitAny: test mock for fetch
    }) as any;

    await bbCreateBranch("dao/21-telemetry", "feature/telemetry");

    // A slash in the branch name must be percent-encoded in the path, or the
    // request hits the wrong route (branch names are path parameters).
    expect(seen[0]).toContain("feature%2Ftelemetry");
    expect(seen[0]).not.toContain("feature/telemetry");
  });

  it("uses DAO_BITBUCKET_TOKEN when configured token is redacted", () => {
    const previous = process.env.DAO_BITBUCKET_TOKEN;
    delete process.env.DAO_BITBUCKET_TOKEN;

    configureBitbucket({
      enabled: true,
      token: "[REDACTED]",
      username: "u",
      workspace: "w",
      repo: "r",
    });
    expect(isBitbucketEnabled()).toBe(false);

    process.env.DAO_BITBUCKET_TOKEN = "env-token";
    expect(isBitbucketEnabled()).toBe(true);

    if (previous === undefined) {
      delete process.env.DAO_BITBUCKET_TOKEN;
    } else {
      process.env.DAO_BITBUCKET_TOKEN = previous;
    }
  });
});
