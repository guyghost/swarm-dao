import { describe, expect, it } from "bun:test";
import { buildDispatchInstructions, formatDispatchPlan } from "../src/intelligence/swarm.js";
import type { DAOAgent, Proposal } from "../src/types/index.js";

describe("intelligence/swarm.ts", () => {
  it("builds and formats dispatch instructions", () => {
    const proposal: Proposal = {
      id: 2,
      title: "Improve onboarding",
      type: "product-feature",
      description: "desc",
      proposedBy: "user",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    const agents: DAOAgent[] = [
      {
        id: "architect",
        name: "Architect",
        role: "Architecture",
        description: "d",
        systemPrompt: "sp",
        weight: 3,
      },
    ];

    const instructions = buildDispatchInstructions(proposal, agents);
    const text = formatDispatchPlan(proposal, instructions);
    expect(instructions.length).toBe(1);
    expect(text).toContain("Swarm Dispatch Plan");
  });
});
