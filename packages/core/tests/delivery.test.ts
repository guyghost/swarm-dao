import { describe, it, expect, beforeEach } from "bun:test";
import {
  generateDeliveryPlan,
  formatPlan,
  validateProposalQuality,
  verifyExecution,
  createInitialState,
  initializeAgents,
  setState,
} from "@swarm-dao/core";

describe("delivery/plans", () => {
  it("generates delivery plan", () => {
    const proposal = {
      id: 1,
      title: "Feature A",
      type: "product-feature" as const,
      description: "Add feature A",
      proposedBy: "test",
      status: "approved" as const,
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const plan = generateDeliveryPlan(proposal);
    expect(plan.proposalId).toBe(1);
    expect(plan.phases.length).toBeGreaterThan(0);
    expect(plan.branchStrategy).toContain("dao-1");
  });

  it("formats plan", () => {
    const proposal = {
      id: 1,
      title: "Feature A",
      type: "product-feature" as const,
      description: "Add feature A",
      proposedBy: "test",
      status: "approved" as const,
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const plan = generateDeliveryPlan(proposal);
    const formatted = formatPlan(plan);
    expect(formatted).toContain("Delivery Plan");
    expect(formatted).toContain("Phase 1");
  });
});

describe("delivery/execution", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    state.agents = initializeAgents();
    setState(state);
  });

  it("validates proposal quality", () => {
    const proposal = {
      id: 1,
      title: "Test",
      type: "product-feature" as const,
      description: "Test",
      proposedBy: "test",
      status: "open" as const,
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const validation = validateProposalQuality(proposal);
    expect(validation.valid).toBe(false);
    expect(validation.missing).toContain("problemStatement");

    proposal.problemStatement = "This solves a real problem for users.";
    proposal.acceptanceCriteria = ["Test passes"];
    proposal.successMetrics = ["Latency < 100ms"];

    const validation2 = validateProposalQuality(proposal);
    expect(validation2.valid).toBe(true);
  });

  it("verifies execution", () => {
    const proposal = {
      id: 1,
      title: "Test",
      type: "product-feature" as const,
      description: "Test",
      proposedBy: "test",
      status: "executed" as const,
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const verification = verifyExecution(proposal, {
      filesChanged: ["src/feature.ts"],
      expectedFiles: ["src/feature.ts", "tests/feature.test.ts"],
      testsPassed: 5,
      testsFailed: 0,
      compilationOk: true,
      gitClean: true,
    });

    expect(verification.status).toBe("partial"); // missing expected file
    expect(verification.missingFiles).toContain("tests/feature.test.ts");
  });
});