import { describe, expect, it } from "bun:test";
import {
  buildModelResolutionContext,
  describeModelResolution,
  resolveAgentModel,
} from "../src/intelligence/model.js";
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
  const ctx = buildModelResolutionContext("dao-default", {
    parentSessionModel: "parent-model",
    hostDefaultModel: "host-default",
  });

  it("prefers agent.model over all fallbacks", () => {
    const agent = { ...baseAgent, model: "agent-override" };
    expect(resolveAgentModel(agent, ctx)).toBe("agent-override");
    expect(describeModelResolution(agent, "agent-override", ctx)).toContain("agent override");
  });

  it("inherits parent session model when agent has no model", () => {
    expect(resolveAgentModel(baseAgent, ctx)).toBe("parent-model");
    expect(describeModelResolution(baseAgent, "parent-model", ctx)).toContain("inherited from parent session");
  });

  it("falls back to DAO default when parent session model is absent", () => {
    const noParent = buildModelResolutionContext("dao-default", { hostDefaultModel: "host-default" });
    expect(resolveAgentModel(baseAgent, noParent)).toBe("dao-default");
    expect(describeModelResolution(baseAgent, "dao-default", noParent)).toContain("DAO default");
  });

  it("falls back to host default when agent, parent, and DAO defaults are absent", () => {
    const hostOnly = buildModelResolutionContext("", { hostDefaultModel: "host-default" });
    expect(resolveAgentModel(baseAgent, hostOnly)).toBe("host-default");
    expect(describeModelResolution(baseAgent, "host-default", hostOnly)).toContain("host default");
  });

  it("returns literal default when nothing is configured", () => {
    const empty = buildModelResolutionContext("");
    expect(resolveAgentModel(baseAgent, empty)).toBe("default");
  });
});