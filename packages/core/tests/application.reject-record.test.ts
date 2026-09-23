import { describe, expect, it } from "bun:test";
import { InMemoryDaoStateRepository } from "../src/adapters/persistence/in-memory-dao-state.repository.js";
import { RecordDeliberationOutputsUseCase } from "../src/application/proposals/record-deliberation-outputs.use-case.js";
import { RejectProposalUseCase } from "../src/application/proposals/reject-proposal.use-case.js";
import { initializeAgents } from "../src/governance/agents.js";
import { createInitialState } from "../src/types/index.js";

function clock() {
  return { now: () => "2031-01-01T00:00:00.000Z" };
}

describe("RejectProposalUseCase", () => {
  it("discards a controlled proposal", async () => {
    const state = createInitialState("/tmp/dao-reject");
    state.initialized = true;
    state.proposals.push({
      id: 1,
      title: "Ship later",
      type: "product-feature",
      description: "d",
      proposedBy: "user",
      status: "controlled",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const result = await new RejectProposalUseCase({ repository, clock: clock() }).execute({
      proposalId: 1,
      actor: "cli",
      reason: "scope changed",
    });
    expect(result).toMatchObject({ ok: true, via: "DISCARD", status: "rejected" });
    expect(state.proposals[0]?.status).toBe("rejected");
  });
});

describe("RecordDeliberationOutputsUseCase", () => {
  it("rejects unknown agent ids without recording", async () => {
    const state = createInitialState("/tmp/dao-record");
    state.initialized = true;
    state.agents = initializeAgents();
    state.proposals.push({
      id: 1,
      title: "Record",
      type: "product-feature",
      description: "d",
      proposedBy: "user",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const result = await new RecordDeliberationOutputsUseCase({ repository, clock: clock() }).execute({
      proposalId: 1,
      outputs: [{ agentId: "not-a-real-agent", content: "## Vote\nfor" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not-a-real-agent");
    expect(state.proposals[0]?.status).toBe("deliberating");
    expect(state.proposals[0]?.votes).toEqual([]);
  });

  it("rejects a partial council without recording", async () => {
    const state = createInitialState("/tmp/dao-record-partial");
    state.initialized = true;
    state.agents = [
      {
        id: "architect",
        name: "Architect",
        role: "Architecture",
        description: "Reviews architecture",
        systemPrompt: "Review",
        weight: 3,
      },
      {
        id: "critic",
        name: "Critic",
        role: "Risk",
        description: "Reviews risk",
        systemPrompt: "Review",
        weight: 3,
      },
    ];
    state.proposals.push({
      id: 1,
      title: "Record",
      type: "product-feature",
      description: "d",
      proposedBy: "user",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const result = await new RecordDeliberationOutputsUseCase({ repository, clock: clock() }).execute({
      proposalId: 1,
      outputs: [{ agentId: "architect", content: "## Vote\nfor" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("critic");
    expect(state.proposals[0]?.status).toBe("deliberating");
    expect(state.proposals[0]?.votes).toEqual([]);
  });
});
