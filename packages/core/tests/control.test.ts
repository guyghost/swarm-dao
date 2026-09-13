import { beforeEach, describe, expect, it } from "bun:test";
import {
  createInitialState,
  DEFAULT_CONFIG,
  formatControlResult,
  initializeAgents,
  runGates,
  setState,
} from "@guyghost/swarm-dao-core";

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
      votes: [{ agentId: "a", agentName: "A", position: "for" as const, reasoning: "Good", weight: 3 }],
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
      gates: [{ gateId: "quorum", name: "Quorum", passed: true, severity: "blocker" as const, message: "Quorum met" }],
      checklist: [{ id: "sec", category: "security" as const, label: "Security", checked: true, autoChecked: true }],
    };
    const formatted = formatControlResult(result);
    expect(formatted).toContain("ALL GATES PASSED");
    expect(formatted).toContain("Quorum");
  });

  it("uses config typeQuorum override for quorum-quality gate", () => {
    const proposal = {
      id: 2,
      title: "Quorum Override Test",
      type: "product-feature" as const,
      description: "Validate quorum override in gate",
      proposedBy: "test",
      status: "approved" as const,
      votes: Array.from({ length: 5 }, (_, i) => ({
        agentId: `v${i}`,
        agentName: `Voter ${i}`,
        position: "for" as const,
        reasoning: "ok",
        weight: 1,
      })),
      agentOutputs: Array.from({ length: 10 }, (_, i) => ({
        agentId: `a${i}`,
        agentName: `Agent ${i}`,
        content: "ok",
      })),
      acceptanceCriteria: ["Gate should respect override"],
      successMetrics: ["Override applied"],
      createdAt: new Date().toISOString(),
    };

    const config = {
      ...DEFAULT_CONFIG,
      typeQuorum: {
        ...DEFAULT_CONFIG.typeQuorum,
        "product-feature": { quorumPercent: 40, approvalPercent: 55, description: "Overridden for test" },
      },
    };

    const result = runGates(proposal, config);
    const quorumGate = result.gates.find((g) => g.gateId === "quorum-quality");
    expect(quorumGate).toBeDefined();
    expect(quorumGate?.passed).toBe(true);
    expect(quorumGate?.message).toContain("50%");
    expect(quorumGate?.message).toContain("40%");
  });

  it("fails type-specific-quality when approval is below the type bar", () => {
    const proposal = {
      id: 3,
      title: "Auth change",
      type: "security-change" as const,
      description: "Security proposal",
      proposedBy: "test",
      status: "approved" as const,
      votes: [
        { agentId: "a", agentName: "A", position: "for" as const, reasoning: "ok", weight: 3 },
        { agentId: "b", agentName: "B", position: "for" as const, reasoning: "ok", weight: 3 },
        { agentId: "c", agentName: "C", position: "against" as const, reasoning: "no", weight: 3 },
      ],
      agentOutputs: [],
      acceptanceCriteria: ["Reviewed"],
      createdAt: new Date().toISOString(),
    };

    const result = runGates(proposal, DEFAULT_CONFIG);
    const gate = result.gates.find((item) => item.gateId === "type-specific-quality");
    expect(gate?.passed).toBe(false);
    expect(gate?.severity).toBe("blocker");
    expect(result.blockerCount).toBeGreaterThan(0);
  });

  it("fails dependency-conflict when in-flight proposals share affected paths", () => {
    const proposal = {
      id: 4,
      title: "Touch auth",
      type: "technical-change" as const,
      description: "desc",
      proposedBy: "test",
      status: "approved" as const,
      votes: [{ agentId: "a", agentName: "A", position: "for" as const, reasoning: "ok", weight: 3 }],
      agentOutputs: [],
      affectedPaths: ["src/auth/login.ts"],
      acceptanceCriteria: ["ok"],
      createdAt: new Date().toISOString(),
    };
    const other = {
      ...proposal,
      id: 5,
      title: "Other auth work",
      status: "controlled" as const,
    };

    const result = runGates(proposal, DEFAULT_CONFIG, { allProposals: [proposal, other] });
    const gate = result.gates.find((item) => item.gateId === "dependency-conflict");
    expect(gate?.passed).toBe(false);
    expect(gate?.message).toContain("#5");
  });
});
