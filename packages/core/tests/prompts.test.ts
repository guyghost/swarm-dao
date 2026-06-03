import { beforeEach, describe, expect, it } from "bun:test";
import {
  createPromptVariant,
  formatPromptComparison,
  getSystemPrompt,
  recordPromptInvocation,
  registerAgentPrompts,
  resetPromptRegistries,
} from "../src/agents/prompts.js";
import type { DAOAgent } from "../src/types/index.js";

describe("agents/prompts.ts", () => {
  beforeEach(() => {
    resetPromptRegistries();
  });

  it("registers prompt variants and compares them", () => {
    const agent: DAOAgent = {
      id: "a1",
      name: "Agent",
      role: "Role",
      description: "d",
      systemPrompt: "default",
      weight: 2,
    };
    const variant = createPromptVariant(agent.id, "v1", "Variant 1", "custom", 100);
    registerAgentPrompts(agent.id, [variant]);
    recordPromptInvocation(agent.id, "v1", 120, { position: "for", confidence: 8 });
    expect(getSystemPrompt(agent, "v1")).toBe("custom");
    expect(formatPromptComparison(agent.id)).toContain("Prompt A/B Test Results");
  });
});
