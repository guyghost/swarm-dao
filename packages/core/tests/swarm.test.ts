import { describe, expect, it } from "bun:test";
import { buildModelResolutionContext } from "../src/intelligence/model.js";
import { buildDispatchInstructions, formatDispatchPlan } from "../src/intelligence/swarm.js";
import type { DAOAgent, Proposal } from "../src/types/index.js";

describe("intelligence/swarm.ts", () => {
  it("builds and formats dispatch instructions with resolved models", () => {
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
        model: "agent-model",
      },
      {
        id: "critic",
        name: "Critic",
        role: "Risk",
        description: "d",
        systemPrompt: "sp",
        weight: 3,
      },
    ];

    const modelContext = buildModelResolutionContext("dao-default", {
      parentSessionModel: "parent-model",
    });
    const instructions = buildDispatchInstructions(proposal, agents, modelContext);
    const text = formatDispatchPlan(proposal, instructions);

    expect(instructions.length).toBe(2);
    expect(instructions[0]?.model).toBe("agent-model");
    expect(instructions[1]?.model).toBe("parent-model");
    expect(text).toContain("Swarm Dispatch Plan");
    expect(text).toContain('model="agent-model"');
    expect(text).toContain('model="parent-model"');
    expect(text).toContain("agent override");
    expect(text).toContain("inherited from parent session");
  });
});
