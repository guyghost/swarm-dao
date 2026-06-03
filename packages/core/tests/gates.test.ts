import { describe, expect, it } from "bun:test";
import { runGates } from "../src/control/gates.js";
import type { Proposal } from "../src/types/index.js";
import { DEFAULT_CONFIG } from "../src/types/index.js";

describe("control/gates.ts", () => {
  it("produces gate results", () => {
    const proposal: Proposal = {
      id: 1,
      title: "Test",
      type: "product-feature",
      description: "desc",
      proposedBy: "user",
      status: "controlled",
      votes: [{ agentId: "a", agentName: "A", position: "for", reasoning: "ok", weight: 3 }],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const result = runGates(proposal, DEFAULT_CONFIG);
    expect(result.gates.length).toBeGreaterThan(0);
  });
});
