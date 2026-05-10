import { describe, it, expect } from "bun:test";
import {
  computeHealthScore,
  formatHealthScore,
  generateDashboard,
  validateWeights,
  getHealthTrend,
  formatHealthTrend,
  DEFAULT_HEALTH_WEIGHTS,
} from "@guyghost/swarm-dao-core";

describe("health-score", () => {
  it("returns insufficient data for empty proposals", () => {
    const score = computeHealthScore([], {}, DEFAULT_HEALTH_WEIGHTS);
    expect(score.insufficientData).toBe(true);
    expect(score.score).toBe(0);
  });

  it("computes health score", () => {
    const proposals = [
      { id: 1, title: "A", type: "product-feature" as const, description: "", proposedBy: "", status: "executed" as const, votes: [], agentOutputs: [{ agentId: "a", agentName: "A", role: "r", content: "", durationMs: 0 }], createdAt: "" },
      { id: 2, title: "B", type: "product-feature" as const, description: "", proposedBy: "", status: "rejected" as const, votes: [], agentOutputs: [], createdAt: "" },
      { id: 3, title: "C", type: "product-feature" as const, description: "", proposedBy: "", status: "executed" as const, votes: [], agentOutputs: [{ agentId: "a", agentName: "A", role: "r", content: "", durationMs: 0 }, { agentId: "b", agentName: "B", role: "r", content: "", durationMs: 0 }], createdAt: "" },
    ];

    const outcomes = {
      1: { proposalId: 1, ratings: [{ proposalId: 1, rater: "user", score: 4, comment: "Good", ratedAt: "" }], metrics: [], overallScore: 4, status: "tracked" as const, createdAt: "", updatedAt: "" },
    };

    const score = computeHealthScore(proposals, outcomes, DEFAULT_HEALTH_WEIGHTS);
    expect(score.score).toBeGreaterThan(0);
    expect(score.label).toBeDefined();
    expect(score.metrics.length).toBe(4);
    expect(score.insufficientData).toBe(false);
  });

  it("formats health score", () => {
    const score = computeHealthScore([], {}, DEFAULT_HEALTH_WEIGHTS);
    const formatted = formatHealthScore(score);
    expect(formatted).toContain("Health Score");
  });

  it("generates dashboard", () => {
    const proposals = [
      { id: 1, title: "A", type: "product-feature" as const, description: "", proposedBy: "", status: "open" as const, votes: [], agentOutputs: [], createdAt: "" },
      { id: 2, title: "B", type: "product-feature" as const, description: "", proposedBy: "", status: "executed" as const, votes: [], agentOutputs: [], createdAt: "" },
    ];

    const dashboard = generateDashboard(proposals, {}, [
      { id: "a", name: "Agent A", weight: 3 },
    ]);

    expect(dashboard).toContain("DAO Dashboard");
    expect(dashboard).toContain("open: 1");
    expect(dashboard).toContain("executed: 1");
  });

  it("computes health trend", () => {
    const snapshots = [
      { weekKey: "W1", year: 2026, week: 1, score: 60, metrics: [], proposalCount: 5, createdAt: "" },
      { weekKey: "W2", year: 2026, week: 2, score: 75, metrics: [], proposalCount: 6, createdAt: "" },
    ];
    const trend = getHealthTrend(snapshots);
    expect(trend.improving).toBe(true);
    expect(trend.change).toBe(15);
  });

  it("formats health trend", () => {
    expect(formatHealthTrend({ improving: true, change: 10 })).toContain("📈");
    expect(formatHealthTrend({ improving: false, change: -5 })).toContain("📉");
  });
});