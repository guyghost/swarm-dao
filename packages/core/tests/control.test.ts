import { describe, it, expect, beforeEach } from "bun:test";
import { runGates, formatControlResult, createInitialState, initializeAgents, DEFAULT_CONFIG, setState } from "@guyghost/swarm-dao-core";

describe("control/gates", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    state.agents = initializeAgents();
    setState(state);
  });

  it("runs all gates on approved proposal", () => {
    const proposal = {
      id: 1,
      title: "Test",
      type: "product-feature" as const,
      description: "Test proposal",
      proposedBy: "test",
      status: "approved" as const,
      votes: [
        { agentId: "a", agentName: "A", position: "for" as const, reasoning: "Good", weight: 3 },
      ],
      agentOutputs: [],
      acceptanceCriteria: ["Test passes"],
      successMetrics: ["Latency < 100ms"],
      createdAt: new Date().toISOString(),
    };

    const result = runGates(proposal, DEFAULT_CONFIG);
    expect(result.gates.length).toBeGreaterThan(0);
    expect(result.checklist.length).toBeGreaterThan(0);
    expect(typeof result.allGatesPassed).toBe("boolean");
  });

  it("formats control result", () => {
    const result = {
      proposalId: 1,
      timestamp: new Date().toISOString(),
      allGatesPassed: true,
      blockerCount: 0,
      warningCount: 0,
      gates: [
        { gateId: "quorum", name: "Quorum", passed: true, severity: "blocker" as const, message: "Quorum met" },
      ],
      checklist: [
        { id: "sec", category: "security" as const, label: "Security", checked: true, autoChecked: true },
      ],
    };
    const formatted = formatControlResult(result);
    expect(formatted).toContain("ALL GATES PASSED");
    expect(formatted).toContain("Quorum");
  });
});