import { describe, it, expect } from "bun:test";
import { formatRoundTableResults } from "@swarm-dao/core";
import type { RoundTableSuggestion } from "@swarm-dao/core";

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
});