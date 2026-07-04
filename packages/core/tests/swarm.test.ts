import { describe, expect, it, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import {
  createInitialState,
  type DaoToolContext,
  getState,
  handleDaoRoundtable,
  setState,
} from "@guyghost/swarm-dao-core";
import { buildModelResolutionContext } from "../src/intelligence/model.js";
import { buildDispatchInstructions, dispatchSwarm, formatDispatchPlan } from "../src/intelligence/swarm.js";
import type { AgentOutput, DAOAgent, HostAdapter, Proposal } from "../src/types/index.js";

describe("intelligence/swarm.ts", () => {
  it("builds and formats dispatch instructions with resolved models", () => {
    const proposal: Proposal = {
      id: 2,
      title: "Improve onboarding",
      type: "product-feature",
      description: "desc",
      proposedBy: "user",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    const agents: DAOAgent[] = [
      {
        id: "architect",
        name: "Architect",
        role: "Architecture",
        description: "d",
        systemPrompt: "sp",
        weight: 3,
        model: "agent-model",
      },
      {
        id: "critic",
        name: "Critic",
        role: "Risk",
        description: "d",
        systemPrompt: "sp",
        weight: 3,
      },
    ];

    const modelContext = buildModelResolutionContext("dao-default", {
      parentSessionModel: "parent-model",
    });
    const instructions = buildDispatchInstructions(proposal, agents, modelContext);
    const text = formatDispatchPlan(proposal, instructions);

    expect(instructions.length).toBe(2);
    expect(instructions[0]?.model).toBe("agent-model");
    expect(instructions[1]?.model).toBe("parent-model");
    expect(text).toContain("Swarm Dispatch Plan");
    expect(text).toContain('model="agent-model"');
    expect(text).toContain('model="parent-model"');
    expect(text).toContain("agent override");
    expect(text).toContain("inherited from parent session");
  });

  it("dispatchSwarm resolves each agent via the lookup map and preserves mapping", async () => {
    const proposal: Proposal = {
      id: 3,
      title: "Dispatch test",
      type: "product-feature",
      description: "desc",
      proposedBy: "user",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    const agents: DAOAgent[] = [
      { id: "alpha", name: "Alpha", role: "r-alpha", description: "d", systemPrompt: "sp", weight: 1 },
      { id: "beta", name: "Beta", role: "r-beta", description: "d", systemPrompt: "sp", weight: 2 },
      { id: "gamma", name: "Gamma", role: "r-gamma", description: "d", systemPrompt: "sp", weight: 3 },
    ];
    const dispatched: string[] = [];
    const adapter = {
      hostId: "test-host",
      spawnAgent: async ({ agent }: { agent: DAOAgent }): Promise<AgentOutput> => {
        dispatched.push(agent.id);
        return {
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          content: `output from ${agent.id}`,
          durationMs: 1,
        };
      },
    } as unknown as HostAdapter;

    const modelContext = buildModelResolutionContext("dao-default", {});
    const outputs = await dispatchSwarm(proposal, agents, adapter, 2, modelContext);

    // Every agent was resolved from the lookup map and dispatched exactly once.
    expect(dispatched.sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(outputs.length).toBe(3);
    // The per-agent role round-trips, proving each output maps to the right agent.
    expect(outputs.map((o) => o.role).sort()).toEqual(["r-alpha", "r-beta", "r-gamma"]);
  });
});

describe("handleDaoRoundtable — batched audit writes (task 8)", () => {
  it("records all audit entries in a single save burst, not one-per-proposal", async () => {
    const daoRoot = `/tmp/dao-roundtable-perf-${Date.now()}`;
    try {
      const state = createInitialState(daoRoot);
      state.initialized = true;
      setState(state);

      // Fake adapter: every agent returns a parseable round-table suggestion, so
      // each agent yields one created proposal (k = number of default agents).
      const adapter = {
        hostId: "test-host",
        spawnAgent: async ({ agent }: { agent: DAOAgent }): Promise<AgentOutput> => ({
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          content: `## Suggested Proposal\n**Title:** Suggestion from ${agent.id}\n**Type:** product-feature\n**Description:** A feature proposed by ${agent.name}.`,
          durationMs: 1,
        }),
      } as unknown as HostAdapter;
      const ctx: DaoToolContext = {
        adapter,
        workDir: daoRoot,
        deliberationMode: "auto",
        controlToolName: "dao_control",
      };

      const writeSpy = spyOn(fs, "writeFile");
      writeSpy.mockClear();

      await handleDaoRoundtable(ctx);

      const writeCount = writeSpy.mock.calls.length;
      writeSpy.mockRestore();

      const after = getState();
      const createdProposals = after.proposals;
      const entries = after.auditLog.filter((e) => e.action === "roundtable_proposal_created");

      // Correctness: one audit entry per created proposal, with the exact recordAudit shape.
      expect(createdProposals.length).toBeGreaterThan(3);
      expect(entries.length).toBe(createdProposals.length);
      for (const entry of entries) {
        expect(entry.layer).toBe("intelligence");
        expect(entry.details).toBe("Auto-created from round table");
        expect(typeof entry.id).toBe("number");
        expect(typeof entry.timestamp).toBe("string");
        expect(typeof entry.proposalId).toBe("number");
        expect(typeof entry.actor).toBe("string");
      }
      // Each audit entry references a real created proposal id.
      const proposalIds = new Set(createdProposals.map((p) => p.id));
      for (const entry of entries) {
        expect(proposalIds.has(entry.proposalId)).toBe(true);
      }

      // Performance: writes must NOT scale with the number of proposals.
      // Old code issued one full saveState per proposal (~k writes via recordAudit);
      // the batched approach appends in-memory and persists once.
      // Sanity: the spy intercepted at least one write (saves actually happened).
      expect(writeCount).toBeGreaterThanOrEqual(1);
      // Single save burst: a constant number of writes, bounded independent of k.
      // (One save = state.json + decisions index.json; here createProposalsBatch +
      //  trailing save = 3 writes for any k. Old code was ~k+2, i.e. 9 for k=7.)
      expect(writeCount).toBeLessThanOrEqual(4);
      // And strictly sub-linear in the number of created proposals.
      expect(writeCount).toBeLessThan(createdProposals.length);
    } finally {
      setState(null);
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
