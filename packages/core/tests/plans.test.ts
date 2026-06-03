import { describe, expect, it } from "bun:test";
import { formatPlan, generateDeliveryPlan, parseDeliveryPlan } from "../src/delivery/plans.js";
import type { Proposal } from "../src/types/index.js";

describe("delivery/plans.ts", () => {
  it("generates and formats plans", () => {
    const proposal: Proposal = {
      id: 3,
      title: "Add telemetry",
      type: "technical-change",
      description: "desc",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const plan = generateDeliveryPlan(proposal);
    const text = formatPlan(plan);
    const parsed = parseDeliveryPlan(text);
    expect(plan.phases.length).toBeGreaterThan(0);
    expect(text).toContain("Delivery Plan");
    expect(parsed.phases?.length).toBeGreaterThan(0);
  });
});
