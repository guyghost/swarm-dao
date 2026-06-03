import { beforeEach, describe, expect, it } from "bun:test";
import {
  calculateCompositeScore,
  calculateRICEScore,
  classifyRiskZone,
  createInitialState,
  DEFAULT_CONFIG,
  executeAmendment,
  formatAgentsTable,
  initializeAgents,
  parseVoteFromOutput,
  setState,
  statusLabel,
  tallyVotes,
  transitionProposal,
  validateAmendmentPayload,
} from "@guyghost/swarm-dao-core";

// ── Agents ──────────────────────────────────────────────────

describe("governance/agents", () => {
  it("initializes default agents", () => {
    const agents = initializeAgents();
    expect(agents.length).toBe(7);
    expect(agents[0].id).toBe("strategist");
    expect(agents[0].weight).toBe(3);
  });

  it("formats agent table", () => {
    const agents = initializeAgents();
    const table = formatAgentsTable(agents);
    expect(table).toContain("Product Strategist");
    expect(table).toContain("| 3 |");
  });
});

// ── Voting ──────────────────────────────────────────────────

describe("governance/voting", () => {
  it("parses vote from output", () => {
    const output = `## Analysis\nGood idea.\n\n## Vote\nfor\n\n## Reasoning\nLow risk, high impact.`;
    const vote = parseVoteFromOutput("strategist", "Product Strategist", 3, output);
    expect(vote).toBeDefined();
    expect(vote?.position).toBe("for");
    expect(vote?.weight).toBe(3);
  });

  it("tallies votes correctly", () => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    state.agents = initializeAgents();
    setState(state);

    const proposal = {
      id: 1,
      title: "Test",
      type: "product-feature" as const,
      description: "Test proposal",
      proposedBy: "test",
      status: "deliberating" as const,
      votes: [
        { agentId: "strategist", agentName: "Strategist", position: "for" as const, reasoning: "Good", weight: 3 },
        { agentId: "architect", agentName: "Architect", position: "for" as const, reasoning: "OK", weight: 3 },
        { agentId: "critic", agentName: "Critic", position: "against" as const, reasoning: "Risky", weight: 3 },
      ],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const tally = tallyVotes(proposal, DEFAULT_CONFIG);
    expect(tally.quorumMet).toBe(true);
    expect(tally.weightedFor).toBe(6);
    expect(tally.weightedAgainst).toBe(3);
    expect(tally.approved).toBe(true); // 6/9 = 66% > 55%
  });
});

// ── Scoring ─────────────────────────────────────────────────

describe("governance/scoring", () => {
  it("calculates composite score", () => {
    const outputs = [
      {
        agentId: "strategist",
        agentName: "Strategist",
        role: "vision",
        content: `## Composite Score Inputs (0-10)\n- userImpact: 8\n- businessImpact: 7\n- effort: 3\n- securityRisk: 2\n- confidence: 9`,
        durationMs: 100,
      },
    ];
    const score = calculateCompositeScore(outputs);
    expect(score.weighted).toBeGreaterThan(0);
    expect(score.riskZone).toBeDefined();
  });

  it("assigns green zone for high-scoring outputs (0-10 scale)", () => {
    // userImpact:9, businessImpact:9, effort:1(→9inv), securityRisk:1(→9inv), confidence:9
    // weighted = 9*0.3 + 9*0.2 + 9*0.15 + 9*0.2 + 9*0.15 = 9.0 → green (≥7.0)
    const outputs = [
      {
        agentId: "strategist",
        agentName: "Strategist",
        role: "vision",
        content: `## Composite Score Inputs (0-10)\n- userImpact: 9\n- businessImpact: 9\n- effort: 1\n- securityRisk: 1\n- confidence: 9`,
        durationMs: 100,
      },
    ];
    const score = calculateCompositeScore(outputs);
    expect(score.weighted).toBeGreaterThanOrEqual(7.0);
    expect(score.riskZone).toBe("green");
  });

  it("assigns orange zone for mid-range scores (0-10 scale)", () => {
    // userImpact:5, businessImpact:5, effort:5(→5inv), securityRisk:5(→5inv), confidence:5
    // weighted = 5*1.0 = 5.0 → orange (≥4.0, <7.0)
    const outputs = [
      {
        agentId: "strategist",
        agentName: "Strategist",
        role: "vision",
        content: `## Composite Score Inputs (0-10)\n- userImpact: 5\n- businessImpact: 5\n- effort: 5\n- securityRisk: 5\n- confidence: 5`,
        durationMs: 100,
      },
    ];
    const score = calculateCompositeScore(outputs);
    expect(score.weighted).toBeGreaterThanOrEqual(4.0);
    expect(score.weighted).toBeLessThan(7.0);
    expect(score.riskZone).toBe("orange");
  });

  it("assigns red zone for low scores (0-10 scale)", () => {
    // All zeroes → weighted = 0 → red (<4.0)
    const outputs = [
      {
        agentId: "strategist",
        agentName: "Strategist",
        role: "vision",
        content: `## Composite Score Inputs (0-10)\n- userImpact: 0\n- businessImpact: 0\n- effort: 10\n- securityRisk: 10\n- confidence: 0`,
        durationMs: 100,
      },
    ];
    const score = calculateCompositeScore(outputs);
    expect(score.weighted).toBeLessThan(4.0);
    expect(score.riskZone).toBe("red");
  });

  it("calculates RICE score", () => {
    const score = calculateRICEScore(1000, 5, 80, 2);
    expect(score.riceScore).toBe((1000 * 5 * 0.8) / 2);
  });
});

// ── Lifecycle ───────────────────────────────────────────────

describe("governance/lifecycle", () => {
  it("classifies risk zone", () => {
    const proposal = {
      id: 1,
      title: "Add auth",
      type: "product-feature" as const,
      description: "Add authentication",
      proposedBy: "test",
      status: "open" as const,
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    expect(classifyRiskZone(proposal)).toBe("red"); // contains "auth"
  });

  it("transitions proposal states", () => {
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

    const r1 = transitionProposal(proposal, "deliberate");
    expect(r1.success).toBe(true);
    expect(proposal.status).toBe("deliberating");

    const r2 = transitionProposal(proposal, "approve");
    expect(r2.success).toBe(true);
    expect(proposal.status).toBe("approved");
  });

  it("returns status label", () => {
    expect(statusLabel("approved")).toContain("Approved");
  });
});

// ── Amendments ──────────────────────────────────────────────

describe("governance/amendments", () => {
  beforeEach(() => {
    const state = createInitialState("/tmp/dao-test");
    state.initialized = true;
    state.agents = initializeAgents();
    setState(state);
  });

  it("validates amendment payload", () => {
    const payload = { type: "agent-update" as const, agentId: "strategist", changes: { weight: 5 } };
    const result = validateAmendmentPayload(payload);
    expect(result.valid).toBe(true);
  });

  it("executes agent-update amendment", () => {
    const payload = { type: "agent-update" as const, agentId: "strategist", changes: { weight: 5 } };
    const result = executeAmendment(payload);
    expect(result.success).toBe(true);

    setState(null);
    // Weight should be updated in state
  });
});
