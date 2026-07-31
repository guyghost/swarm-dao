import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileDaoStateRepository, type InMemoryDaoStateRepository } from "@guyghost/swarm-dao-core";
import { benchmarkProposal, initializedRepository, initializedState } from "../src/fixtures.js";
import type { BenchmarkSuite } from "../src/harness.js";

let workDir: string;
let memoryRepository: InMemoryDaoStateRepository;
let fileRepository: FileDaoStateRepository;
let largeFileRepository: FileDaoStateRepository;

async function openSeeded(dir: string, proposals: number): Promise<FileDaoStateRepository> {
  const repository = await FileDaoStateRepository.open(dir);
  const seed = initializedState(path.join(dir, ".dao"));
  const state = repository.get();
  state.agents = seed.agents;
  state.initialized = true;
  for (let index = 0; index < proposals; index++) state.proposals.push(benchmarkProposal(index + 1));
  state.nextProposalId = proposals + 1;
  await repository.persist();
  return repository;
}

/** Persistence cost: in-memory vs filesystem, small vs large state. */
export const persistenceSuite: BenchmarkSuite = {
  name: "persistence",
  iterations: 20,
  setup: async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-bench-"));
    memoryRepository = initializedRepository();
    for (let index = 0; index < 100; index++) memoryRepository.get().proposals.push(benchmarkProposal(index + 1));
    fileRepository = await openSeeded(path.join(workDir, "small"), 1);
    largeFileRepository = await openSeeded(path.join(workDir, "large"), 500);
  },
  teardown: async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  },
  cases: [
    {
      name: "in-memory persist (100 proposals)",
      run: async () => {
        await memoryRepository.persist();
      },
    },
    {
      name: "file persist (1 proposal)",
      run: async () => {
        const state = fileRepository.get();
        state.proposals[0] = { ...benchmarkProposal(1), title: `Touched ${Math.random()}` };
        await fileRepository.persist();
      },
    },
    {
      name: "file persist (500 proposals)",
      run: async () => {
        const state = largeFileRepository.get();
        state.proposals[0] = { ...benchmarkProposal(1), title: `Touched ${Math.random()}` };
        await largeFileRepository.persist();
      },
    },
    {
      name: "file persist (unchanged state)",
      run: async () => {
        await largeFileRepository.persist();
      },
    },
    {
      name: "file reload (500 proposals)",
      run: async () => {
        await FileDaoStateRepository.open(path.join(workDir, "large"));
      },
    },
  ],
};
