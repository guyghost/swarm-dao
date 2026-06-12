import { describe, expect, it } from "bun:test";
import { bbBranchNameFor, configureBitbucket, isBitbucketEnabled } from "../src/integrations/bitbucket.js";
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
