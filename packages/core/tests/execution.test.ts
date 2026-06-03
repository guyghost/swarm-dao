import { describe, expect, it } from "bun:test";
import { formatVerification, validateProposalQuality } from "../src/delivery/execution.js";
import type { ExecutionVerification, Proposal } from "../src/types/index.js";

describe("delivery/execution.ts", () => {
  it("validates proposal quality and formats verification", () => {
    const proposal: Proposal = {
      id: 9,
      title: "Execution test",
      type: "product-feature",
      description: "desc",
      proposedBy: "user",
      status: "controlled",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
      problemStatement: "Too short",
    };
    const quality = validateProposalQuality(proposal);
    expect(quality.valid).toBe(false);

    const verification: ExecutionVerification = {
      proposalId: 9,
      status: "success",
      timestamp: new Date().toISOString(),
      filesChanged: ["a.ts"],
      missingFiles: [],
      compilationOk: true,
      gitClean: true,
      summary: "ok",
    };
    expect(formatVerification(verification)).toContain("Verification");
  });
});
