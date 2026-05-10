import { describe, it, expect } from "bun:test";
import {
  generateAllArtefacts,
  formatAllArtefacts,
  formatArtefactsSummary,
  generateDecisionBrief,
  generateADR,
  generateRiskReport,
  generatePRDLite,
  generateImplementationPlan,
  generateTestPlan,
  generateReleasePacket,
} from "@guyghost/swarm-dao-core";

describe("delivery/artefacts", () => {
  const mockProposal = {
    id: 42,
    title: "Add dark mode",
    type: "product-feature" as const,
    description: "Implement a dark theme for the application",
    problemStatement: "Users request dark mode for better night usage",
    acceptanceCriteria: ["Toggle works", "Persists preference"],
    successMetrics: ["Adoption > 50%"],
    proposedBy: "test",
    status: "approved" as const,
    votes: [
      { agentId: "a", agentName: "Strategist", position: "for" as const, reasoning: "Good", weight: 3 },
      { agentId: "b", agentName: "Critic", position: "against" as const, reasoning: "Risky", weight: 3 },
    ],
    agentOutputs: [],
    createdAt: "2026-01-01T00:00:00Z",
    riskZone: "orange" as const,
  };

  it("generates all artefacts", () => {
    const artefacts = generateAllArtefacts(mockProposal);
    expect(artefacts.proposalId).toBe(42);
    expect(artefacts.decisionBrief).toBeDefined();
    expect(artefacts.adr).toBeDefined();
    expect(artefacts.riskReport).toBeDefined();
    expect(artefacts.prdLite).toBeDefined();
    expect(artefacts.implementationPlan).toBeDefined();
    expect(artefacts.testPlan).toBeDefined();
    expect(artefacts.releasePacket).toBeDefined();
    expect(artefacts.generatedAt).toBeDefined();
  });

  it("formats all artefacts", () => {
    const artefacts = generateAllArtefacts(mockProposal);
    const formatted = formatAllArtefacts(artefacts);
    expect(formatted).toContain("Decision Brief");
    expect(formatted).toContain("ADR-042");
    expect(formatted).toContain("Risk Report");
    expect(formatted).toContain("PRD Lite");
    expect(formatted).toContain("Implementation Plan");
    expect(formatted).toContain("Test Plan");
    expect(formatted).toContain("Release Packet");
  });

  it("formats summary", () => {
    const artefacts = generateAllArtefacts(mockProposal);
    const summary = formatArtefactsSummary(artefacts);
    expect(summary).toContain("Release Packet");
    expect(summary).toContain("✅");
  });

  it("generates decision brief with correct approval score", () => {
    const brief = generateDecisionBrief(mockProposal);
    expect(brief.proposalId).toBe(42);
    expect(brief.decision).toBe("approved");
    expect(brief.keyAgents.length).toBe(2);
  });

  it("generates ADR", () => {
    const adr = generateADR(mockProposal);
    expect(adr.adrId).toBe("ADR-042");
    expect(adr.status).toBe("proposed");
  });

  it("generates risk report for orange zone", () => {
    const report = generateRiskReport(mockProposal);
    expect(report.overallRiskScore).toBe(5);
    expect(report.riskLevel).toBe("medium");
    expect(report.risks.length).toBeGreaterThan(0);
  });

  it("generates PRD lite with user stories", () => {
    const prd = generatePRDLite(mockProposal);
    expect(prd.userStories.length).toBe(2); // from acceptanceCriteria
    expect(prd.objective).toBe(mockProposal.problemStatement);
  });

  it("generates implementation plan", () => {
    const plan = generateImplementationPlan(mockProposal);
    expect(plan.phases.length).toBe(3);
    expect(plan.branchStrategy).toContain("dao-42");
  });

  it("generates test plan", () => {
    const plan = generateTestPlan(mockProposal);
    expect(plan.unitTests.length).toBe(1);
    expect(plan.e2eTests.length).toBe(1);
  });

  it("generates release packet", () => {
    const packet = generateReleasePacket(mockProposal);
    expect(packet.version).toBe("1.0.0");
    expect(packet.changelog).toContain("dark mode");
  });
});