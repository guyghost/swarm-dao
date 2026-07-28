import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import {
  type AgentOutput,
  ControlProposalUseCase,
  CreateAmendmentProposalUseCase,
  CreateProposalUseCase,
  createInitialState,
  type DAOAgent,
  DeliberateProposalUseCase,
  DryRunProposalUseCase,
  ExecuteProposalUseCase,
  FileDaoStateRepository,
  getState,
  InitializeDaoUseCase,
  InMemoryDaoStateRepository,
  presentProposalCreated,
  RateProposalUseCase,
  RecordDeliberationOutputsUseCase,
  RollbackProposalUseCase,
  RoundTableUseCase,
  ShipProposalUseCase,
  StartDeliberationUseCase,
  setRepository,
  TransitionProposalUseCase,
  UpdateProposalUseCase,
} from "@guyghost/swarm-dao-core";

describe("application architecture", () => {
  it("keeps repository instances isolated", async () => {
    const first = new InMemoryDaoStateRepository(createInitialState("/first/.dao"));
    const second = new InMemoryDaoStateRepository(createInitialState("/second/.dao"));

    first.get().initialized = true;
    await first.persist();

    expect(first.get().initialized).toBe(true);
    expect(second.get().initialized).toBe(false);
  });

  it("routes compatibility persistence APIs through an explicit repository instance", () => {
    const first = new InMemoryDaoStateRepository(createInitialState("/first/.dao"));
    const second = new InMemoryDaoStateRepository(createInitialState("/second/.dao"));
    try {
      setRepository(first);
      expect(getState().daoRoot).toBe("/first/.dao");
      setRepository(second);
      expect(getState().daoRoot).toBe("/second/.dao");
    } finally {
      setRepository(null);
    }
  });

  it("persists and reloads isolated file repository instances", async () => {
    const firstRoot = `/tmp/swarm-dao-repository-first-${Date.now()}`;
    const secondRoot = `/tmp/swarm-dao-repository-second-${Date.now()}`;
    try {
      const first = await FileDaoStateRepository.open(firstRoot);
      const second = await FileDaoStateRepository.open(secondRoot);
      first.get().initialized = true;
      first.get().nextProposalId = 42;
      await first.persist();
      await second.persist();

      const reloadedFirst = await FileDaoStateRepository.open(firstRoot);
      const reloadedSecond = await FileDaoStateRepository.open(secondRoot);
      expect(reloadedFirst.get().nextProposalId).toBe(42);
      expect(reloadedSecond.get().nextProposalId).toBe(1);
    } finally {
      await fs.rm(firstRoot, { recursive: true, force: true });
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("creates a proposal through an injected repository and clock", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/project/.dao"));
    repository.get().initialized = true;
    const useCase = new CreateProposalUseCase({
      repository,
      clock: { now: () => "2031-02-03T04:05:06.000Z" },
    });

    const result = await useCase.execute({
      title: "Hexagonal core",
      type: "technical-change",
      description: "Separate the domain from I/O",
      proposedBy: "user",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal).toMatchObject({
      id: 1,
      status: "open",
      riskZone: "orange",
      createdAt: "2031-02-03T04:05:06.000Z",
    });
    expect(repository.get().proposals).toHaveLength(1);
  });

  it("creates governance amendments through a dedicated use case", async () => {
    const state = createInitialState("/project/.dao");
    state.initialized = true;
    const repository = new InMemoryDaoStateRepository(state);
    const useCase = new CreateAmendmentProposalUseCase({
      repository,
      clock: { now: () => "2031-02-03T04:05:06.000Z" },
    });

    const result = await useCase.execute({
      title: "Remove obsolete agent",
      description: "Retire an obsolete council participant",
      payload: { type: "agent-remove", agentId: "obsolete" },
      proposedBy: "user",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal).toMatchObject({
      type: "governance-change",
      amendmentState: "pending-vote",
      amendmentPayload: { type: "agent-remove", agentId: "obsolete" },
    });
  });

  it("presents a structured proposal result outside the use case", () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/project/.dao"));
    const proposal = {
      ...repository.get().proposals[0],
      id: 7,
      title: "Ports",
      type: "technical-change" as const,
      description: "Narrow ports",
      proposedBy: "user",
      status: "open" as const,
      votes: [],
      agentOutputs: [],
      riskZone: "green" as const,
      createdAt: "2031-02-03T04:05:06.000Z",
    };

    expect(presentProposalCreated(proposal)).toContain("Proposal Created — #7");
  });

  it("persists model-approved transitions through the repository port", async () => {
    const state = createInitialState("/project/.dao");
    state.proposals.push({
      id: 1,
      title: "Transition",
      type: "technical-change",
      description: "Use the model",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const useCase = new TransitionProposalUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:01:00.000Z" },
    });

    const result = await useCase.execute({ proposalId: 1, event: { type: "DELIBERATE" } });

    expect(result).toMatchObject({ ok: true, status: "deliberating" });
    expect(repository.get().proposals[0]?.status).toBe("deliberating");
  });

  it("orchestrates AI signals without letting the worker choose proposal state", async () => {
    const state = createInitialState("/project/.dao");
    const agent: DAOAgent = {
      id: "architect",
      name: "Architect",
      role: "Architecture",
      description: "Reviews architecture",
      systemPrompt: "Review the proposal",
      weight: 3,
    };
    state.initialized = true;
    state.agents = [agent];
    state.proposals.push({
      id: 1,
      title: "Hexagonal workflow",
      type: "technical-change",
      description: "Move orchestration into a use case",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const worker = {
      spawnAgent: async (): Promise<AgentOutput> => ({
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        content: "## Vote\nfor\n\n## Reasoning\nThe boundaries are explicit.",
        durationMs: 1,
      }),
      spawnAgents: async (): Promise<AgentOutput[]> => [],
    };
    const repository = new InMemoryDaoStateRepository(state);
    const useCase = new DeliberateProposalUseCase({
      repository,
      worker,
      clock: { now: () => "2031-01-01T00:01:00.000Z" },
    });

    const result = await useCase.execute({ proposalId: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tally.approved).toBe(true);
    expect(repository.get().proposals[0]?.status).toBe("approved");
    expect(repository.get().auditLog.map((entry) => entry.action)).toEqual([
      "deliberation_started",
      "deliberation_approved",
    ]);
  });

  it("records manually collected AI signals through the same model boundary", async () => {
    const state = createInitialState("/project/.dao");
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
    ];
    state.proposals.push({
      id: 1,
      title: "Manual signals",
      type: "technical-change",
      description: "Record host-collected outputs",
      proposedBy: "user",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const useCase = new RecordDeliberationOutputsUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:01:00.000Z" },
    });

    const result = await useCase.execute({
      proposalId: 1,
      outputs: [
        {
          agentId: "architect",
          content: "## Vote\nfor\n\n## Reasoning\nThe model remains authoritative.",
          durationMs: 3,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(repository.get().proposals[0]?.status).toBe("approved");
  });

  it("runs control gates against injected state and records a deterministic result", async () => {
    const state = createInitialState("/project/.dao");
    state.initialized = true;
    state.proposals.push({
      id: 1,
      title: "Controlled workflow",
      type: "product-feature",
      description: "Run deterministic gates",
      proposedBy: "user",
      status: "approved",
      votes: [{ agentId: "a", agentName: "A", position: "for", reasoning: "Good", weight: 3 }],
      agentOutputs: [{ agentId: "a", agentName: "A", role: "review", content: "ok", durationMs: 1 }],
      acceptanceCriteria: ["The gates run"],
      successMetrics: ["All blockers pass"],
      riskZone: "green",
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const useCase = new ControlProposalUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:02:00.000Z" },
    });

    const result = await useCase.execute({ proposalId: 1, failOnGateFailure: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.control.timestamp).toBe("2031-01-01T00:02:00.000Z");
    expect(repository.get().proposals[0]?.status).toBe("controlled");
    expect(repository.get().deliveryPlans[1]).toBeDefined();
  });

  it("executes a controlled proposal without persistence or time hidden in delivery code", async () => {
    const state = createInitialState("/project/.dao");
    state.initialized = true;
    state.proposals.push({
      id: 1,
      title: "Execute through application",
      type: "technical-change",
      description: "Keep effects in the shell",
      proposedBy: "user",
      status: "controlled",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const useCase = new ExecuteProposalUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:03:00.000Z" },
    });

    const result = await useCase.execute({ proposalId: 1, actor: "user" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.status).toBe("executed");
    expect(result.proposal.resolvedAt).toBe("2031-01-01T00:03:00.000Z");
    expect(repository.get().snapshots[1]?.timestamp).toBe("2031-01-01T00:03:00.000Z");
  });

  it("ships through the execution use case and returns structured ids", async () => {
    const state = createInitialState("/project/.dao");
    state.initialized = true;
    state.proposals.push({
      id: 1,
      title: "Ship through application",
      type: "release-change",
      description: "Centralize shipping",
      proposedBy: "user",
      status: "controlled",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);
    const useCase = new ShipProposalUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:04:00.000Z" },
    });

    const result = await useCase.execute({ proposalId: 1, actor: "test-host" });

    expect(result).toEqual({ ok: true, shipped: [1] });
    expect(repository.get().proposals[0]?.status).toBe("executed");
  });

  it("initializes DAO state through an injected repository", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/project/.dao"));
    const agent: DAOAgent = {
      id: "architect",
      name: "Architect",
      role: "Architecture",
      description: "Reviews architecture",
      systemPrompt: "Review",
      weight: 3,
    };

    const result = await new InitializeDaoUseCase({ repository }).execute({ agents: [agent] });

    expect(result).toEqual({ ok: true, agents: [agent] });
    expect(repository.get().initialized).toBe(true);
  });

  it("starts manual deliberation through the state model", async () => {
    const state = createInitialState("/project/.dao");
    state.initialized = true;
    state.proposals.push({
      id: 1,
      title: "Manual deliberation",
      type: "technical-change",
      description: "Start from a use case",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);

    const result = await new StartDeliberationUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:01:00.000Z" },
    }).execute({ proposalId: 1 });

    expect(result).toMatchObject({ ok: true, proposal: { status: "deliberating" } });
    expect(repository.get().auditLog[0]).toMatchObject({
      timestamp: "2031-01-01T00:01:00.000Z",
      action: "deliberation_started",
    });
  });

  it("updates only open proposals through a use case", async () => {
    const state = createInitialState("/project/.dao");
    state.proposals.push({
      id: 1,
      title: "Update",
      type: "technical-change",
      description: "Update through application",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);

    const result = await new UpdateProposalUseCase({ repository }).execute({
      proposalId: 1,
      fields: { acceptanceCriteria: ["Mutation is centralized"] },
    });

    expect(result).toMatchObject({ ok: true, proposal: { acceptanceCriteria: ["Mutation is centralized"] } });
  });

  it("records outcome ratings with injected time", async () => {
    const state = createInitialState("/project/.dao");
    state.proposals.push({
      id: 1,
      title: "Rate",
      type: "technical-change",
      description: "Rate through application",
      proposedBy: "user",
      status: "executed",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);

    const result = await new RateProposalUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:05:00.000Z" },
    }).execute({ proposalId: 1, rater: "user", score: 5, comment: "Clear boundaries" });

    expect(result).toMatchObject({ ok: true, rating: { ratedAt: "2031-01-01T00:05:00.000Z" } });
    expect(repository.get().outcomes[1]?.overallScore).toBe(5);
  });

  it("records dry-run analysis with injected time", async () => {
    const state = createInitialState("/project/.dao");
    state.proposals.push({
      id: 1,
      title: "Dry run",
      type: "technical-change",
      description: "Preview through application",
      proposedBy: "user",
      status: "controlled",
      votes: [],
      agentOutputs: [],
      affectedPaths: ["packages/core"],
      acceptanceCriteria: ["Preview generated"],
      createdAt: "2031-01-01T00:00:00.000Z",
    });
    const repository = new InMemoryDaoStateRepository(state);

    const result = await new DryRunProposalUseCase({
      repository,
      clock: { now: () => "2031-01-01T00:06:00.000Z" },
    }).execute({ proposalId: 1 });

    expect(result).toMatchObject({ ok: true, analysis: { filesAffected: ["packages/core"], canProceed: true } });
    expect(repository.get().proposals[0]?.dryRunAt).toBe("2031-01-01T00:06:00.000Z");
  });

  it("turns round-table AI suggestions into proposals through application policy", async () => {
    const state = createInitialState("/project/.dao");
    state.initialized = true;
    state.agents = [
      {
        id: "architect",
        name: "Architect",
        role: "Architecture",
        description: "Reviews architecture",
        systemPrompt: "Suggest an improvement",
        weight: 3,
      },
    ];
    const repository = new InMemoryDaoStateRepository(state);
    const worker = {
      spawnAgent: async (): Promise<AgentOutput> => ({
        agentId: "architect",
        agentName: "Architect",
        role: "Architecture",
        content:
          "## Suggested Proposal\n**Title:** Enforce ports\n**Type:** technical-change\n**Description:** Add architectural contracts.",
        durationMs: 1,
      }),
      spawnAgents: async (): Promise<AgentOutput[]> => [],
    };

    const result = await new RoundTableUseCase({
      repository,
      worker,
      clock: { now: () => "2031-01-01T00:07:00.000Z" },
    }).execute({ agents: state.agents });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestions[0]?.proposalId).toBe(1);
    expect(repository.get().proposals[0]).toMatchObject({ title: "Enforce ports", status: "open" });
  });

  it("rolls back from a snapshot without reopening a terminal proposal", async () => {
    const state = createInitialState("/project/.dao");
    state.proposals.push({
      id: 1,
      title: "Executed proposal",
      type: "technical-change",
      description: "Keep terminal history immutable",
      proposedBy: "user",
      status: "executed",
      votes: [],
      agentOutputs: [],
      createdAt: "2031-01-01T00:00:00.000Z",
      resolvedAt: "2031-01-01T00:01:00.000Z",
    });
    state.snapshots[1] = {
      proposalId: 1,
      timestamp: "2031-01-01T00:00:30.000Z",
      branch: "main",
      commitSha: "abc123def456",
      filesChanged: [],
      stateSnapshot: "{}",
    };
    const repository = new InMemoryDaoStateRepository(state);

    const result = await new RollbackProposalUseCase({ repository }).execute({ proposalId: 1 });

    expect(result).toMatchObject({ ok: true, snapshot: { commitSha: "abc123def456" } });
    expect(repository.get().proposals[0]?.status).toBe("executed");
  });
});
