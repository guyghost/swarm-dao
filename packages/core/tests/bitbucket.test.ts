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
});
