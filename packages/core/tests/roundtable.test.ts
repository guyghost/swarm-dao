import { describe, expect, it } from "bun:test";
import type { RoundTableSuggestion } from "@guyghost/swarm-dao-core";
import { formatRoundTableResults } from "@guyghost/swarm-dao-core";
import { buildModelResolutionContext } from "../src/intelligence/model.js";
import { runRoundTable } from "../src/intelligence/roundtable.js";
import type { AgentOutput, DAOAgent } from "../src/types/index.js";

describe("intelligence/roundtable", () => {
  it("formats round table results", () => {
    const suggestions: RoundTableSuggestion[] = [
      {
        agentId: "strategist",
        agentName: "Product Strategist",
        content: "test",
        parsed: { title: "Add search", type: "product-feature", description: "Add search functionality" },
        proposalId: 1,
      },
      {
        agentId: "critic",
        agentName: "Critic",
        content: "test",
        error: "Timeout",
      },
    ];

    const formatted = formatRoundTableResults(suggestions);
    expect(formatted).toContain("Round Table Results");
    expect(formatted).toContain("Add search");
    expect(formatted).toContain("Timeout");
  });

  it("shares the project brief with every round table participant", async () => {
    const prompts: string[] = [];
    const agent = (id: string): DAOAgent => ({
      id,
      name: id,
      role: "r",
      description: "d",
      systemPrompt: "sp",
      weight: 1,
    });
    const adapter = {
      spawnAgent: async (input: { systemPrompt: string }): Promise<AgentOutput> => {
        prompts.push(input.systemPrompt);
        return {
          agentId: input.systemPrompt.includes("strategist") ? "strategist" : "critic",
          agentName: "a",
          role: "r",
          content: "## Suggested Proposal\n**Title:** t\n**Type:** technical-change\n**Description:** d",
          durationMs: 1,
        };
      },
      spawnAgents: async (): Promise<AgentOutput[]> => [],
    };

    const suggestions = await runRoundTable(
      adapter,
      [agent("strategist"), agent("critic")],
      2,
      buildModelResolutionContext("dao-default", {}),
      { now: () => "2031-01-01T00:00:00.000Z" },
      { projectBrief: "SCOUT-BRIEF-MARKER" },
    );

    expect(prompts.length).toBe(2);
    for (const prompt of prompts) {
      expect(prompt).toContain("SCOUT-BRIEF-MARKER");
      expect(prompt).toContain("DAO Round Table");
    }
    expect(suggestions.length).toBe(2);
  });
});
