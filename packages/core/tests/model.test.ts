import { describe, expect, it } from "bun:test";
import { buildModelResolutionContext, describeModelResolution, resolveAgentModel } from "../src/intelligence/model.js";
import type { DAOAgent } from "../src/types/index.js";

const baseAgent: DAOAgent = {
  id: "architect",
  name: "Architect",
  role: "Architecture",
  description: "d",
  systemPrompt: "sp",
  weight: 3,
};

describe("intelligence/model.ts", () => {
  const ctx = buildModelResolutionContext({
    parentSessionModel: "parent-model",
    hostDefaultModel: "host-default",
  });

  it("prefers agent.model over all fallbacks", () => {
    const agent = { ...baseAgent, model: "agent-override" };
    expect(resolveAgentModel(agent, ctx)).toBe("agent-override");
    expect(describeModelResolution(agent, "agent-override", ctx)).toContain("agent override");
  });

  it("treats model 'inherit' as no override", () => {
    const agent = { ...baseAgent, model: "inherit" };
    expect(resolveAgentModel(agent, ctx)).toBe("parent-model");
  });

  it("inherits parent session model when agent has no model", () => {
    expect(resolveAgentModel(baseAgent, ctx)).toBe("parent-model");
    expect(describeModelResolution(baseAgent, "parent-model", ctx)).toContain("inherited from parent session");
  });

  it("falls back to the host main model when the parent session model is absent", () => {
    const noParent = buildModelResolutionContext({ hostDefaultModel: "host-default" });
    expect(resolveAgentModel(baseAgent, noParent)).toBe("host-default");
    expect(describeModelResolution(baseAgent, "host-default", noParent)).toContain("host main model");
  });

  it("returns literal default when nothing resolves (host decides, D3 row 3)", () => {
    const empty = buildModelResolutionContext();
    expect(resolveAgentModel(baseAgent, empty)).toBe("default");
  });
});
