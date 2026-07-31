import {
  ControlProposalUseCase,
  CreateProposalUseCase,
  calculateCompositeScore,
  DeliberateProposalUseCase,
  type InMemoryDaoStateRepository,
  tallyVotes,
} from "@guyghost/swarm-dao-core";
import {
  BENCHMARK_AGENTS,
  benchmarkClock,
  benchmarkProposal,
  benchmarkWorker,
  deliberatedProposal,
  initializedRepository,
} from "../src/fixtures.js";
import type { BenchmarkSuite } from "../src/harness.js";

let repository: InMemoryDaoStateRepository;
let deliberationQueue: number[] = [];
let controlQueue: number[] = [];

/** Governance hot path: proposal creation, swarm deliberation, tally, gates. */
export const deliberationSuite: BenchmarkSuite = {
  name: "deliberation",
  iterations: 25,
  setup: () => {
    repository = initializedRepository();
    const state = repository.get();
    deliberationQueue = [];
    controlQueue = [];
    // Deliberation and control consume a proposal per iteration, so both need a
    // pre-seeded pool: the measured operation must not include fixture cost.
    for (let index = 0; index < 200; index++) {
      const proposal = benchmarkProposal(state.nextProposalId++);
      state.proposals.push(proposal);
      deliberationQueue.push(proposal.id);
    }
    for (let index = 0; index < 200; index++) {
      const proposal = deliberatedProposal(state.nextProposalId++);
      state.proposals.push(proposal);
      controlQueue.push(proposal.id);
    }
  },
  cases: [
    {
      name: "create proposal",
      run: async () => {
        const template = benchmarkProposal(0);
        await new CreateProposalUseCase({ repository, clock: benchmarkClock }).execute({
          title: template.title,
          type: template.type,
          description: template.description,
          proposedBy: "benchmarks",
          acceptanceCriteria: ["Benchmarks run in CI"],
          successMetrics: ["Stable mean duration"],
        });
      },
    },
    {
      name: `deliberate proposal (${BENCHMARK_AGENTS.length} agents)`,
      run: async () => {
        const proposalId = deliberationQueue.pop();
        if (proposalId === undefined) throw new Error("deliberation pool exhausted — raise the seeded pool size");
        await new DeliberateProposalUseCase({
          repository,
          worker: benchmarkWorker,
          clock: benchmarkClock,
        }).execute({ proposalId, agents: BENCHMARK_AGENTS });
      },
    },
    {
      name: "run control gates",
      run: async () => {
        const proposalId = controlQueue.pop();
        if (proposalId === undefined) throw new Error("control pool exhausted — raise the seeded pool size");
        await new ControlProposalUseCase({ repository, clock: benchmarkClock }).execute({ proposalId });
      },
    },
    {
      name: "tally + composite score (pure)",
      run: () => {
        const proposal = deliberatedProposal(1);
        calculateCompositeScore(proposal.agentOutputs);
        tallyVotes(proposal, repository.get().config);
      },
    },
  ],
};
