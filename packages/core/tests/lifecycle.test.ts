import { describe, expect, it } from "bun:test";
import { canTransition, classifyRiskZone, statusLabel, transitionProposal } from "../src/governance/lifecycle.js";
import type { Proposal } from "../src/types/index.js";

describe("governance/lifecycle.ts", () => {
  it("transitions proposal lifecycle", () => {
    const proposal: Proposal = {
      id: 1,
      title: "Security hardening",
      type: "security-change",
      description: "desc",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    expect(canTransition("open", "deliberating")).toBe(true);
    expect(classifyRiskZone(proposal)).toBe("red");
    expect(statusLabel("open")).toContain("Open");
    expect(transitionProposal(proposal, "deliberate").success).toBe(true);
  });
});
