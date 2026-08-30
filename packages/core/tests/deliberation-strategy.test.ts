// Deliberation strategy: the sequential pipeline must produce the same
// deterministic outcome (tally decides) while chaining analyses forward —
// and never votes.
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CreateProposalUseCase,
  createInitialState,
  DEFAULT_AGENTS,
  DeliberateProposalUseCase,
  InitializeDaoUseCase,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { InMemoryDaoStateRepository } from "../src/adapters/persistence/in-memory-dao-state.repository.js";
import type { DaoToolContext } from "../src/host-tools/handlers.js";
import { handleDaoDeliberate } from "../src/host-tools/handlers.js";
import type { AgentOutput, HostAdapter } from "../src/types/index.js";

interface SpawnRecord {
  agentId: string;
  prompt: string;
}

function chainedHost(records: SpawnRecord[], mode: "auto" | "manual" = "auto"): HostAdapter {
  return {
    hostId: "strategy-test",
    spawnAgent: async ({ agent, systemPrompt }): Promise<AgentOutput> => {
      records.push({ agentId: agent.id, prompt: systemPrompt });
      return {
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        content: `## Analysis\nChain-marker-${agent.id}.\n\n## Vote\nfor\n\n## Reasoning\nr`,
        durationMs: 0,
      };
    },
    spawnAgents: async () => [],
    log: async () => {},
    getWorkingDirectory: () => "/repo",
    readFile: async () => "",
    writeFile: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    hasCapability: () => mode === "auto",
  };
}

describe("deliberation strategy", () => {
  test("sequential use-case chains analyses forward, never votes, and approves via the tally", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/seq/.dao"));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
    const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "Pipeline Feature",
      type: "product-feature",
      description: "d",
      proposedBy: "test",
    });
    if (!created.ok) throw new Error(created.error);

    const records: SpawnRecord[] = [];
    const result = await new DeliberateProposalUseCase({
      repository,
      worker: chainedHost(records),
      clock: systemClock,
    }).execute({ proposalId: created.proposal.id, strategy: "sequential" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tally.approved).toBe(true);

    // Strictly sequential: the agents run one at a time, in registry order.
    expect(records.length).toBe(DEFAULT_AGENTS.length);
    expect(records[0]?.agentId).toBe(DEFAULT_AGENTS[0]?.id);
    expect(records[1]?.agentId).toBe(DEFAULT_AGENTS[1]?.id);

    // The first agent gets no prior section; the second gets the first's
    // analysis marker but never the first's vote (the agent's own system
    // prompt documents the vote format, so scope the check to the section).
    expect(records[0]?.prompt).not.toContain("## Prior Analyses");
    expect(records[1]?.prompt).toContain(`Chain-marker-${DEFAULT_AGENTS[0]?.id}`);
    const priorSection = records[1]?.prompt.split("## Prior Analyses")[1] ?? "";
    expect(priorSection).not.toContain("## Vote");
    // The last agent has seen every analysis before it.
    const last = records.at(-1)?.prompt ?? "";
    for (const agent of DEFAULT_AGENTS.slice(0, -1)) {
      expect(last).toContain(`Chain-marker-${agent.id}`);
    }

    expect(repository.get().proposals.find((p) => p.id === created.proposal.id)?.status).toBe("approved");
  });

  test("the default (no strategy) stays fully parallel", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/par/.dao"));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
    const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "Parallel Feature",
      type: "product-feature",
      description: "d",
      proposedBy: "test",
    });
    if (!created.ok) throw new Error(created.error);

    const records: SpawnRecord[] = [];
    const result = await new DeliberateProposalUseCase({
      repository,
      worker: chainedHost(records),
      clock: systemClock,
    }).execute({ proposalId: created.proposal.id });

    expect(result.ok).toBe(true);
    // No chaining in parallel mode: nobody sees anybody's marker.
    expect(records[1]?.prompt).not.toContain(`Chain-marker-${DEFAULT_AGENTS[0]?.id}`);
  });

  test("handleDaoDeliberate reads the strategy from the project config (auto host)", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-seqcfg-"));
    const daoRoot = path.join(root, ".dao");
    await fs.mkdir(daoRoot, { recursive: true });
    await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ deliberation: { strategy: "sequential" } }));
    try {
      const repository = new InMemoryDaoStateRepository(createInitialState(daoRoot));
      await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
      const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
        title: "Config Feature",
        type: "product-feature",
        description: "d",
        proposedBy: "test",
      });
      if (!created.ok) throw new Error(created.error);

      const records: SpawnRecord[] = [];
      const ctx: DaoToolContext = {
        adapter: chainedHost(records),
        workDir: root,
        deliberationMode: "auto",
        controlToolName: "dao_check",
        repository,
      };
      const output = await handleDaoDeliberate(ctx, created.proposal.id);

      expect(output).toContain("APPROVED");
      expect(records[1]?.prompt).toContain(`Chain-marker-${DEFAULT_AGENTS[0]?.id}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("manual hosts get the pipeline protocol in the dispatch plan", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-seqman-"));
    const daoRoot = path.join(root, ".dao");
    await fs.mkdir(daoRoot, { recursive: true });
    await fs.writeFile(
      path.join(daoRoot, "config.json"),
      JSON.stringify({ deliberation: { strategy: "sequential", charsPerAgent: 900 } }),
    );
    try {
      const repository = new InMemoryDaoStateRepository(createInitialState(daoRoot));
      await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
      const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
        title: "Manual Feature",
        type: "product-feature",
        description: "d",
        proposedBy: "test",
      });
      if (!created.ok) throw new Error(created.error);

      const ctx: DaoToolContext = {
        adapter: chainedHost([], "manual"),
        workDir: root,
        deliberationMode: "manual",
        controlToolName: "dao_control",
        repository,
      };
      const plan = await handleDaoDeliberate(ctx, created.proposal.id);

      expect(plan).toContain("Sequential Pipeline");
      expect(plan).toContain("in the listed order");
      expect(plan).toContain("900 characters");
      expect(plan).toContain("Never forward votes or reasoning");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
