import { beforeEach, describe, expect, it } from "bun:test";
import type { Proposal } from "@guyghost/swarm-dao-core";
import {
  calculateCompositeScore,
  calculateRICEScore,
  classifyRiskZone,
  createInitialState,
  DEFAULT_CONFIG,
  dispatchProposalEvent,
  executeAmendment,
  formatAgentsTable,
  getState,
  initializeAgents,
  mergeVotes,
  parseVoteFromOutput,
  setState,
  statusLabel,
  tallyVotes,
  validateAmendmentPayload,
} from "@guyghost/swarm-dao-core";

// ── Agents ──────────────────────────────────────────────────

describe("governance/agents", () => {
  it("initializes default agents", () => {
    const agents = initializeAgents();
    expect(agents.length).toBe(8);
    expect(agents[0]?.id).toBe("strategist");
    expect(agents[0]?.weight).toBe(3);
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

  it("returns no vote when the output has no vote section", () => {
    const output = "## Analysis\nLooks reasonable, not voting yet.";
    expect(parseVoteFromOutput("strategist", "Product Strategist", 3, output)).toBeUndefined();
  });

  it("does not treat the charter placeholder as a for vote", () => {
    expect(
      parseVoteFromOutput(
        "critic",
        "Critic",
        3,
        "## Analysis\nrisky.\n\n## Vote\nfor | against | abstain\n\n## Reasoning\nUnsure.",
      ),
    ).toBeUndefined();
    expect(
      parseVoteFromOutput(
        "critic",
        "Critic",
        3,
        "## Analysis\nrisky.\n\n## Vote\n<for|against|abstain>\n\n## Reasoning\nUnsure.",
      ),
    ).toBeUndefined();
  });

  it("skips a placeholder Vote section and uses the later real vote", () => {
    const output = `## Vote
for | against | abstain

## Vote
against

## Reasoning
Too broad.`;
    expect(parseVoteFromOutput("critic", "Critic", 3, output)?.position).toBe("against");
  });

  it("ignores ## Vote headings inside fenced code blocks", () => {
    const output = `## Analysis
Format reminder:

\`\`\`markdown
## Vote
against
\`\`\`

## Vote
for

## Reasoning
Real vote is for.`;
    expect(parseVoteFromOutput("critic", "Critic", 3, output)?.position).toBe("for");
  });

  it("parses a vote from a rendered transcript whose ## glyphs are gone (issue #178)", () => {
    // pi's TUI renders markdown, so herdr harvests the rendered text:
    // headings appear without the leading `##`.
    const output = `Analysis
Good idea.

Vote

for

Reasoning
Low risk, high impact.`;
    const vote = parseVoteFromOutput("strategist", "Product Strategist", 3, output);
    expect(vote?.position).toBe("for");
    expect(vote?.reasoning).toBe("Low risk, high impact.");
  });

  it("does not treat charter placeholders as votes in a rendered transcript", () => {
    expect(
      parseVoteFromOutput(
        "critic",
        "Critic",
        3,
        "Analysis\nrisky.\n\nVote\nfor | against | abstain\n\nReasoning\nUnsure.",
      ),
    ).toBeUndefined();
    expect(
      parseVoteFromOutput(
        "critic",
        "Critic",
        3,
        "Analysis\nrisky.\n\nVote\n<for|against|abstain>\n\nReasoning\nUnsure.",
      ),
    ).toBeUndefined();
  });

  it("does not let a delegated child's vote become the parent's", () => {
    const output = `## Analysis
Parent analysis, no vote section.

## Delegated Facets

### security (from child)
## Analysis
Child analysis.

## Vote
against

## Reasoning
Child reasoning.`;
    expect(parseVoteFromOutput("critic", "Critic", 3, output)).toBeUndefined();
  });

  it("merges votes: incoming replaces same agent only, others preserved", () => {
    const existing = [
      { agentId: "cli-user", agentName: "cli-user", position: "against" as const, reasoning: "Human veto", weight: 5 },
      { agentId: "strategist", agentName: "Strategist", position: "abstain" as const, reasoning: "Round 1", weight: 3 },
    ];
    const incoming = [
      { agentId: "strategist", agentName: "Strategist", position: "for" as const, reasoning: "Round 2", weight: 3 },
      { agentId: "architect", agentName: "Architect", position: "for" as const, reasoning: "New", weight: 3 },
    ];
    const merged = mergeVotes(existing, incoming);
    expect(merged.map((vote) => [vote.agentId, vote.position])).toEqual([
      ["cli-user", "against"],
      ["strategist", "for"],
      ["architect", "for"],
    ]);
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

  it("applies type-specific approval thresholds (security-change requires 70%)", () => {
    const proposal = {
      id: 3,
      title: "Tighten auth",
      type: "security-change" as const,
      description: "Security proposal",
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
    expect(tally.approvalScore).toBe(67);
    expect(tally.approved).toBe(false);
  });

  it("ignores invalid vote weights when tallying", () => {
    const proposal = {
      id: 2,
      title: "Invalid weights",
      type: "product-feature" as const,
      description: "Test proposal",
      proposedBy: "test",
      status: "deliberating" as const,
      votes: [
        { agentId: "strategist", agentName: "Strategist", position: "for" as const, reasoning: "Good", weight: 3 },
        {
          agentId: "broken",
          agentName: "Broken",
          position: "against" as const,
          reasoning: "Bad",
          weight: Number.NaN,
        },
      ],
      agentOutputs: [{ agentId: "strategist", agentName: "Strategist", role: "vision", content: "", durationMs: 1 }],
      createdAt: new Date().toISOString(),
    };

    const tally = tallyVotes(proposal, DEFAULT_CONFIG);
    expect(Number.isFinite(tally.weightedFor)).toBe(true);
    expect(Number.isFinite(tally.weightedAgainst)).toBe(true);
    expect(Number.isFinite(tally.approvalScore)).toBe(true);
    expect(Number.isFinite(tally.quorumPercent)).toBe(true);
    expect(tally.weightedAgainst).toBe(0);
  });

  it("silent council members carry their configured weight, not weight 1 (issue #155a)", () => {
    const proposal = {
      id: 10,
      title: "Weighted electorate",
      type: "technical-change" as const,
      description: "d",
      proposedBy: "test",
      status: "deliberating" as const,
      votes: [{ agentId: "strategist", agentName: "S", position: "for" as const, reasoning: "ok", weight: 3 }],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    // strategist(3) voted; architect(3) and critic(3) silent → denominator 9.
    const electorate = [
      { id: "strategist", weight: 3 },
      { id: "architect", weight: 3 },
      { id: "critic", weight: 3 },
    ];
    const tally = tallyVotes(proposal, DEFAULT_CONFIG, electorate);
    expect(tally.quorumPercent).toBe(33); // 3/9, not 60
    expect(tally.quorumMet).toBe(false);
  });

  it("the denominator never undercuts the votes cast, even with many outsider votes (issue #155b)", () => {
    const votes = ["h1", "h2", "h3", "h4", "h5"].map((agentId) => ({
      agentId,
      agentName: agentId,
      position: "for" as const,
      reasoning: "ok",
      weight: 1,
    }));
    const proposal = {
      id: 11,
      title: "Outsiders",
      type: "technical-change" as const,
      description: "d",
      proposedBy: "test",
      status: "deliberating" as const,
      votes,
      agentOutputs: [
        { agentId: "a", agentName: "A", role: "r", content: "", durationMs: 1 },
        { agentId: "b", agentName: "B", role: "r", content: "", durationMs: 1 },
      ],
      createdAt: new Date().toISOString(),
    };
    const tally = tallyVotes(proposal, DEFAULT_CONFIG);
    expect(tally.quorumPercent).toBeLessThanOrEqual(100);
    expect(tally.quorumMet).toBe(true); // everyone visible voted
  });

  it("a single human vote cannot reach quorum against the configured council (issue #155c)", () => {
    const proposal = {
      id: 12,
      title: "Lone CLI vote",
      type: "technical-change" as const,
      description: "d",
      proposedBy: "cli",
      status: "deliberating" as const,
      votes: [{ agentId: "cli-user", agentName: "cli-user", position: "for" as const, reasoning: "ok", weight: 1 }],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    const electorate = initializeAgents();
    const tally = tallyVotes(proposal, DEFAULT_CONFIG, electorate);
    expect(tally.quorumMet).toBe(false);
    expect(tally.approved).toBe(false);
  });

  it("compares approval as an exact fraction — rounding must not clear the bar (issue #156)", () => {
    const votes = [
      { agentId: "a", agentName: "A", position: "for" as const, reasoning: "ok", weight: 1 },
      { agentId: "b", agentName: "B", position: "for" as const, reasoning: "ok", weight: 1 },
      { agentId: "c", agentName: "C", position: "against" as const, reasoning: "no", weight: 1 },
    ];
    const make = (): Proposal => ({
      id: 13,
      title: "Rounding",
      type: "governance-change" as const,
      description: "d",
      proposedBy: "test",
      status: "deliberating" as const,
      votes: [...votes],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    });
    const config = {
      ...DEFAULT_CONFIG,
      quorumPercent: 0,
      approvalThreshold: 67,
      typeQuorum: {
        ...DEFAULT_CONFIG.typeQuorum,
        "governance-change": { quorumPercent: 0, approvalPercent: 67, description: "test" },
      },
    };

    // 2/1 = 66.67% — Math.round would report 67 and clear the 67% bar.
    const under = tallyVotes(make(), config);
    expect(under.approvalScore).toBe(67); // display rounding
    expect(under.approved).toBe(false); // but the decision uses the exact fraction

    // 3/1 = 75% clears it.
    const over = tallyVotes(
      {
        ...make(),
        votes: [...votes, { agentId: "d", agentName: "D", position: "for" as const, reasoning: "ok", weight: 1 }],
      },
      config,
    );
    expect(over.approved).toBe(true);
  });

  it("applies the quorum threshold as an exact fraction too (issue #156)", () => {
    // 2 of 3 weight voted = 66.67% — must not clear a 67% quorum bar.
    const proposal = {
      id: 14,
      title: "Quorum rounding",
      type: "governance-change" as const,
      description: "d",
      proposedBy: "test",
      status: "deliberating" as const,
      votes: [
        { agentId: "a", agentName: "A", position: "for" as const, reasoning: "ok", weight: 1 },
        { agentId: "b", agentName: "B", position: "abstain" as const, reasoning: "meh", weight: 1 },
      ],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    const electorate = [
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
      { id: "c", weight: 1 },
    ];
    const config = { ...DEFAULT_CONFIG, quorumPercent: 67, approvalThreshold: 51 };
    const tally = tallyVotes(proposal, config, electorate);
    expect(tally.quorumPercent).toBe(67); // display rounding of 66.67
    expect(tally.quorumMet).toBe(false);
    expect(tally.approved).toBe(false);
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
    const proposal: Proposal = {
      id: 1,
      title: "Test",
      type: "product-feature" as const,
      description: "Test",
      proposedBy: "test",
      status: "open" as const,
      votes: [
        { agentId: "a", agentName: "A", position: "for" as const, reasoning: "ok", weight: 1 },
        { agentId: "b", agentName: "B", position: "for" as const, reasoning: "ok", weight: 1 },
      ],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };

    const r1 = dispatchProposalEvent(proposal, { type: "DELIBERATE" });
    expect(r1.ok).toBe(true);
    expect(proposal.status).toBe("deliberating");

    // Guarded events recompute the decision (issue #158): config is required,
    // and the proposal's real votes must genuinely pass.
    const r2 = dispatchProposalEvent(
      proposal,
      {
        type: "APPROVE",
        tally: {
          proposalId: 1,
          approved: true,
          quorumMet: true,
          totalAgents: 5,
          votingAgents: 5,
          quorumPercent: 100,
          weightedFor: 10,
          weightedAgainst: 0,
          totalVotingWeight: 10,
          approvalScore: 100,
          votes: [],
        },
      },
      { config: DEFAULT_CONFIG },
    );
    expect(r2.ok).toBe(true);
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

  it("rejects a gate-update that adds an unknown gate", () => {
    const result = validateAmendmentPayload({ type: "gate-update", addGates: ["not-a-gate"] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unknown gate 'not-a-gate'");
  });

  it("executes agent-update amendment", () => {
    const payload = { type: "agent-update" as const, agentId: "strategist", changes: { weight: 5 } };
    const result = executeAmendment(payload);
    expect(result.success).toBe(true);

    // Verify weight is updated in state
    const agent = getState().agents.find((a) => a.id === "strategist");
    expect(agent).toBeDefined();
    expect(agent?.weight).toBe(5);
  });
});
