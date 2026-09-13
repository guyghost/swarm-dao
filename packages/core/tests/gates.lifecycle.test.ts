// Gates & lifecycle fail-closed semantics (issue #168).
import { describe, expect, test } from "bun:test";
import {
  ControlProposalUseCase,
  CreateProposalUseCase,
  createInitialState,
  DEFAULT_AGENTS,
  DEFAULT_CONFIG,
  dispatchProposalEvent,
  InitializeDaoUseCase,
  runGates,
  systemClock,
  type TallyResult,
} from "@guyghost/swarm-dao-core";
import { InMemoryDaoStateRepository } from "../src/adapters/persistence/in-memory-dao-state.repository.js";
import type { Proposal } from "../src/types/index.js";

function baseProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    title: "T",
    type: "technical-change",
    description: "d",
    proposedBy: "t",
    status: "approved",
    votes: [],
    agentOutputs: [],
    acceptanceCriteria: ["a"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function passedTally(proposalId: number): TallyResult {
  return {
    proposalId,
    approved: true,
    quorumMet: true,
    totalAgents: 8,
    votingAgents: 8,
    quorumPercent: 100,
    weightedFor: 10,
    weightedAgainst: 0,
    totalVotingWeight: 10,
    approvalScore: 100,
    votes: [],
  };
}

describe("risk-threshold fails closed (issue #168.1)", () => {
  test("no risk scores produced → the gate fails", () => {
    const proposal = baseProposal({ agentOutputs: [] });
    const result = runGates(proposal, DEFAULT_CONFIG);
    const gate = result.gates.find((g) => g.gateId === "risk-threshold");
    expect(gate?.passed).toBe(false);
    expect(gate?.message).toContain("No risk scores produced");
  });

  test("outputs without a parsable score → the gate fails", () => {
    const proposal = baseProposal({
      agentOutputs: [{ agentId: "a", agentName: "A", role: "r", content: "no score section", durationMs: 1 }],
    });
    const result = runGates(proposal, DEFAULT_CONFIG);
    expect(result.gates.find((g) => g.gateId === "risk-threshold")?.passed).toBe(false);
  });

  test("for security-change, the missing-score failure is promoted to blocker", () => {
    const proposal = baseProposal({
      type: "security-change",
      agentOutputs: [{ agentId: "a", agentName: "A", role: "r", content: "", durationMs: 1 }],
    });
    const result = runGates(proposal, DEFAULT_CONFIG);
    const gate = result.gates.find((g) => g.gateId === "risk-threshold");
    expect(gate?.severity).toBe("blocker");
    expect(result.blockerCount).toBeGreaterThan(0);
  });
});

describe("control failure transitions by default (issue #168.2)", () => {
  /** An approved proposal whose votes are then sabotaged so the
   *  quorum-quality blocker fails at control time. */
  async function approvedProposalWithBrokenQuorum() {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/ctrl/.dao"));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
    const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "Control me",
      type: "product-feature",
      description: "d",
      proposedBy: "test",
      acceptanceCriteria: ["c"],
    });
    if (!created.ok) throw new Error(created.error);
    const proposal = created.proposal;
    proposal.votes = [
      { agentId: "a", agentName: "A", position: "for", reasoning: "ok", weight: 1 },
      { agentId: "b", agentName: "B", position: "for", reasoning: "ok", weight: 1 },
    ];
    expect(dispatchProposalEvent(proposal, { type: "DELIBERATE" }).ok).toBe(true);
    expect(
      dispatchProposalEvent(proposal, { type: "APPROVE", tally: passedTally(proposal.id) }, { config: DEFAULT_CONFIG })
        .ok,
    ).toBe(true);
    proposal.votes = [];
    return { repository, proposal };
  }

  test("a failing gate leaves the proposal failed unless the caller opts out", async () => {
    const { repository, proposal } = await approvedProposalWithBrokenQuorum();

    const useCase = new ControlProposalUseCase({ repository, clock: systemClock });
    const result = await useCase.execute({ proposalId: proposal.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Explicit resulting status in the return value (issue #168.2).
    expect(result.status).toBe("failed");
    expect(proposal.status).toBe("failed");
  });

  test("failOnGateFailure: false keeps the proposal approved (check-only)", async () => {
    const { repository, proposal } = await approvedProposalWithBrokenQuorum();

    const useCase = new ControlProposalUseCase({ repository, clock: systemClock });
    const result = await useCase.execute({ proposalId: proposal.id, failOnGateFailure: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("approved");
    expect(proposal.status).toBe("approved");
  });
});

describe("dependency cycles are rejected at creation (issue #168.3)", () => {
  test("creating B while A already depends on B fails with a cycle error", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/cycle/.dao"));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
    const a = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "A",
      type: "technical-change",
      description: "d",
      proposedBy: "t",
    });
    if (!a.ok) throw new Error(a.error);
    // Forward reference (imported/hand-edited state): A depends on the
    // not-yet-created #2. Creating #2 that depends on #1 closes the cycle —
    // and must be rejected now, not at ship time.
    a.proposal.dependsOn = [2];

    const result = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "B",
      type: "technical-change",
      description: "d",
      proposedBy: "t",
      dependsOn: [1],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/circular/i);
  });
});

describe("dependency-readiness uses transitive semantics (issue #168.4)", () => {
  test("C→B→A with A unexecuted fails C's gate", () => {
    const a = baseProposal({ id: 1, title: "A", status: "approved" });
    const b = baseProposal({ id: 2, title: "B", status: "controlled", dependsOn: [1] });
    const c = baseProposal({ id: 3, title: "C", status: "approved", dependsOn: [2] });

    const result = runGates(c, DEFAULT_CONFIG, { allProposals: [a, b, c] });
    const gate = result.gates.find((g) => g.gateId === "dependency-readiness");
    expect(gate?.passed).toBe(false);
    expect(gate?.message).toContain("#1");
    expect(gate?.message).toContain("#2");
  });

  test("fully executed chains pass", () => {
    const a = baseProposal({ id: 1, title: "A", status: "executed" });
    const b = baseProposal({ id: 2, title: "B", status: "executed", dependsOn: [1] });
    const c = baseProposal({ id: 3, title: "C", status: "approved", dependsOn: [2] });

    const result = runGates(c, DEFAULT_CONFIG, { allProposals: [a, b, c] });
    expect(result.gates.find((g) => g.gateId === "dependency-readiness")?.passed).toBe(true);
  });
});

describe("runGates survives legacy proposals without agentOutputs (issue #168.6)", () => {
  test("agentOutputs undefined does not throw", () => {
    const proposal = baseProposal({});
    // Simulate an old state.json where the field is absent.
    (proposal as unknown as Record<string, unknown>).agentOutputs = undefined;
    expect(() => runGates(proposal, DEFAULT_CONFIG)).not.toThrow();
  });
});
