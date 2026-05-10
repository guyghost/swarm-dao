import { describe, it, expect, beforeEach } from "bun:test";
import {
  createPromptVariant,
  registerAgentPrompts,
  getPromptVariant,
  getSystemPrompt,
  recordPromptInvocation,
  compareVariants,
  promoteBestVariant,
  formatPromptComparison,
  resetPromptRegistries,
} from "@swarm-dao/core";

describe("agents/prompts", () => {
  beforeEach(() => {
    resetPromptRegistries();
  });

  it("creates prompt variant", () => {
    const variant = createPromptVariant("strategist", "v1", "Standard", "You are a strategist", 100);
    expect(variant.id).toBe("v1");
    expect(variant.weight).toBe(100);
    expect(variant.metrics.invocations).toBe(0);
  });

  it("registers and retrieves prompt variants", () => {
    const v1 = createPromptVariant("strategist", "v1", "Standard", "Prompt A", 70);
    const v2 = createPromptVariant("strategist", "v2", "Experimental", "Prompt B", 30);
    registerAgentPrompts("strategist", [v1, v2]);

    const registry = getPromptVariant("strategist", "v1");
    expect(registry).toBeDefined();
    expect(registry!.name).toBe("Standard");
  });

  it("returns system prompt with variant", () => {
    const agent = {
      id: "strategist",
      name: "Strategist",
      role: "vision",
      description: "test",
      weight: 3,
      systemPrompt: "Default prompt",
    };

    const v1 = createPromptVariant("strategist", "v1", "Standard", "Variant prompt", 100);
    registerAgentPrompts("strategist", [v1]);

    const prompt = getSystemPrompt(agent as any, "v1");
    expect(prompt).toBe("Variant prompt");

    const defaultPrompt = getSystemPrompt(agent as any);
    expect(defaultPrompt).toBe("Variant prompt"); // v1 is only variant, so it's selected
  });

  it("falls back to agent default prompt", () => {
    const agent = {
      id: "strategist",
      name: "Strategist",
      role: "vision",
      description: "test",
      weight: 3,
      systemPrompt: "Default prompt",
    };

    const prompt = getSystemPrompt(agent as any);
    expect(prompt).toBe("Default prompt");
  });

  it("records prompt invocation metrics", () => {
    const v1 = createPromptVariant("strategist", "v1", "Standard", "Prompt", 100);
    registerAgentPrompts("strategist", [v1]);

    recordPromptInvocation("strategist", "v1", 1500, { position: "for", confidence: 8 });
    recordPromptInvocation("strategist", "v1", 2000, { position: "against", confidence: 6 });

    const variant = getPromptVariant("strategist", "v1")!;
    expect(variant.metrics.invocations).toBe(2);
    expect(variant.metrics.votesFor).toBe(1);
    expect(variant.metrics.votesAgainst).toBe(1);
    expect(variant.metrics.avgResponseTimeMs).toBe(1750);
  });

  it("compares variants by score", () => {
    const v1 = createPromptVariant("strategist", "v1", "Standard", "Prompt A", 50);
    const v2 = createPromptVariant("strategist", "v2", "Experimental", "Prompt B", 50);
    registerAgentPrompts("strategist", [v1, v2]);

    // v1 gets good votes
    for (let i = 0; i < 5; i++) {
      recordPromptInvocation("strategist", "v1", 1000, { position: "for", confidence: 9 });
    }

    // v2 gets bad votes
    for (let i = 0; i < 5; i++) {
      recordPromptInvocation("strategist", "v2", 1000, { position: "against", confidence: 3 });
    }

    const comparison = compareVariants("strategist");
    expect(comparison.length).toBe(2);
    expect(comparison[0].variant.id).toBe("v1"); // v1 should score higher
    expect(comparison[0].score).toBeGreaterThan(comparison[1].score);
  });

  it("promotes best variant", () => {
    const v1 = createPromptVariant("strategist", "v1", "Standard", "Prompt A", 50);
    const v2 = createPromptVariant("strategist", "v2", "Experimental", "Prompt B", 50);
    registerAgentPrompts("strategist", [v1, v2]);

    recordPromptInvocation("strategist", "v1", 1000, { position: "for", confidence: 10 });
    recordPromptInvocation("strategist", "v2", 1000, { position: "against", confidence: 2 });

    const best = promoteBestVariant("strategist");
    expect(best!.id).toBe("v1");
  });

  it("formats prompt comparison", () => {
    const v1 = createPromptVariant("strategist", "v1", "Standard", "Prompt A", 100);
    registerAgentPrompts("strategist", [v1]);
    recordPromptInvocation("strategist", "v1", 1200, { position: "for", confidence: 7 });

    const formatted = formatPromptComparison("strategist");
    expect(formatted).toContain("A/B Test Results");
    expect(formatted).toContain("Standard");
    expect(formatted).toContain("Best variant");
  });
});