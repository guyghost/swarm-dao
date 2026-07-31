import {
  type AgentOutput,
  type AgentWorkerPort,
  createInitialState,
  type DAOAgent,
  type DAOState,
  DEFAULT_AGENTS,
  InMemoryDaoStateRepository,
  initializeAgents,
  type Proposal,
  type ProposalType,
} from "@guyghost/swarm-dao-core";

export const BENCHMARK_AGENTS: DAOAgent[] = initializeAgents();

/** Deliberation output shaped for the core vote/score parsers. */
export function benchmarkAgentContent(agent: DAOAgent): string {
  return [
    "## Analysis",
    `${agent.name} reviewed the proposal against ${agent.role} concerns.`,
    "",
    "## Vote",
    "for",
    "",
    "## Reasoning",
    `${agent.name} sees no blocking issue.`,
    "",
    "## Risk Score (1-10)",
    "3",
    "",
  ].join("\n");
}

function output(agent: DAOAgent): AgentOutput {
  return {
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    content: benchmarkAgentContent(agent),
    durationMs: 0,
  };
}

/** In-process worker: measures core orchestration cost, not model latency. */
export const benchmarkWorker: AgentWorkerPort = {
  spawnAgent: async ({ agent }) => output(agent),
  spawnAgents: async ({ agents }) => agents.map(output),
};

export function initializedState(daoRoot = "/benchmarks/.dao"): DAOState {
  const state = createInitialState(daoRoot);
  state.agents = DEFAULT_AGENTS;
  state.initialized = true;
  return state;
}

export function initializedRepository(daoRoot?: string): InMemoryDaoStateRepository {
  return new InMemoryDaoStateRepository(initializedState(daoRoot));
}

export function benchmarkProposal(id: number, type: ProposalType = "product-feature"): Proposal {
  return {
    id,
    title: `Benchmark proposal #${id}`,
    type,
    description: "Synthetic proposal used to measure core throughput.",
    problemStatement: "Core throughput is unmeasured.",
    acceptanceCriteria: ["Benchmarks run in CI", "Regressions fail the build"],
    successMetrics: ["Stable mean duration"],
    rollbackConditions: ["Revert the benchmark suite"],
    proposedBy: "benchmarks",
    status: "open",
    votes: [],
    agentOutputs: [],
    createdAt: "2031-01-01T00:00:00.000Z",
  };
}

/** Proposal carrying full deliberation output, as artefact generation expects. */
export function deliberatedProposal(id: number): Proposal {
  const proposal = benchmarkProposal(id);
  const outputs = BENCHMARK_AGENTS.map(output);
  return {
    ...proposal,
    status: "approved",
    riskZone: "orange",
    agentOutputs: outputs,
    votes: BENCHMARK_AGENTS.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      position: "for" as const,
      reasoning: `${agent.name} sees no blocking issue.`,
      weight: agent.weight,
    })),
    synthesis: "Synthesized decision for benchmarking.",
  };
}

export const benchmarkClock = { now: () => "2031-01-01T00:00:00.000Z" };
