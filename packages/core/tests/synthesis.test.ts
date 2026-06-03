import { describe, expect, it } from "bun:test";
import { formatSynthesis, synthesize } from "../src/intelligence/synthesis.js";
import type { AgentOutput, Proposal } from "../src/types/index.js";

describe("intelligence/synthesis.ts", () => {
  it("builds a synthesis summary", () => {
    const proposal: Proposal = {
      id: 4,
      title: "Improve auth",
      type: "security-change",
      description: "desc",
      proposedBy: "user",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    const outputs: AgentOutput[] = [
      {
        agentId: "a",
        agentName: "A",
        role: "Security",
        content: "ok",
        durationMs: 10,
        vote: { agentId: "a", agentName: "A", position: "for", reasoning: "security improved", weight: 2 },
      },
    ];
    const result = synthesize(proposal, [], outputs, {
      approved: true,
      approvalScore: 70,
      summary: "ok",
      breakdown: [],
    });
    expect(formatSynthesis(result)).toContain("Synthesis");
    expect(result).toContain("APPROVED");
  });
});
