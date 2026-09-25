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

  it("round-trips its own task lines (em-dash separator)", () => {
    const proposal: Proposal = {
      id: 4,
      title: "Round trip",
      type: "technical-change",
      description: "desc",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const plan = generateDeliveryPlan(proposal);
    const parsed = parseDeliveryPlan(formatPlan(plan));
    const parsedTasks = parsed.phases?.flatMap((phase) => phase.tasks) ?? [];
    const originalTasks = plan.phases.flatMap((phase) => phase.tasks);

    // formatPlan emits "**Title** — description": the parser must not drop
    // every task just because the separator is an em-dash, not a hyphen.
    expect(parsedTasks.length).toBe(originalTasks.length);
    expect(parsedTasks.length).toBeGreaterThan(0);
    expect(parsedTasks.map((task) => task.title)).toEqual(originalTasks.map((task) => task.title));
  });
});
