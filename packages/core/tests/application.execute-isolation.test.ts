import { describe, expect, test } from "bun:test";
import {
  ControlProposalUseCase,
  CreateProposalUseCase,
  createInitialState,
  DEFAULT_AGENTS,
  DeliberateProposalUseCase,
  ExecuteProposalUseCase,
  InitializeDaoUseCase,
  ShipProposalUseCase,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { InMemoryDaoStateRepository } from "../src/adapters/persistence/in-memory-dao-state.repository.js";
import type { ExecutionWorkspacePort } from "../src/ports/workspace.js";
import type { AgentOutput, HostAdapter } from "../src/types/index.js";

const approvingHost: HostAdapter = {
  hostId: "test",
  spawnAgent: async ({ agent }): Promise<AgentOutput> => ({
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    content: "## Analysis\na\n## Vote\nfor\n## Reasoning\nr",
    durationMs: 0,
  }),
  spawnAgents: async () => [],
  log: async () => {},
  getWorkingDirectory: () => "/tmp",
  readFile: async () => "",
  writeFile: async () => {},
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  hasCapability: () => true,
};

/** Bring a proposal to `controlled` through the real machine transitions. */
async function controlledProposal(repository: InMemoryDaoStateRepository): Promise<number> {
  await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
  const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
    title: "Isolated Feature",
    type: "product-feature",
    description: "d",
    proposedBy: "test",
  });
  if (!created.ok) throw new Error(created.error);
  const deliberation = await new DeliberateProposalUseCase({
    repository,
    worker: approvingHost,
    clock: systemClock,
  }).execute({ proposalId: created.proposal.id });
  if (!deliberation.ok) throw new Error(deliberation.error);
  const control = await new ControlProposalUseCase({ repository, clock: systemClock }).execute({
    proposalId: created.proposal.id,
  });
  if (!control.ok) throw new Error(control.error);
  return created.proposal.id;
}

describe("ExecuteProposalUseCase with an execution workspace", () => {
  test("prepares the workspace and records the real branch in the snapshot", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/exec-iso/.dao"));
    const proposalId = await controlledProposal(repository);

    const prepared: string[] = [];
    const workspace: ExecutionWorkspacePort = {
      prepare: async (proposal) => {
        prepared.push(`${proposal.id}:${proposal.title}`);
        return { ok: true, branch: `dao/${proposal.id}-isolated-feature`, path: "/repo/.dao/worktrees/x" };
      },
    };

    const result = await new ExecuteProposalUseCase({ repository, clock: systemClock, workspace }).execute({
      proposalId,
      actor: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(prepared).toEqual([`${proposalId}:Isolated Feature`]);
    expect(result.snapshot.branch).toBe(`dao/${proposalId}-isolated-feature`);
    expect(result.proposal.status).toBe("executed");
    const audit = repository
      .get()
      .auditLog.filter((entry) => entry.proposalId === proposalId && entry.layer === "delivery")
      .at(-1);
    expect(audit?.details).toContain(`dao/${proposalId}-isolated-feature`);
  });

  test("a failed workspace preparation blocks execution and leaves the proposal controlled", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/exec-iso-fail/.dao"));
    const proposalId = await controlledProposal(repository);

    const workspace: ExecutionWorkspacePort = {
      prepare: async () => ({ ok: false, error: "fatal: not a git repository" }),
    };

    const result = await new ExecuteProposalUseCase({ repository, clock: systemClock, workspace }).execute({
      proposalId,
      actor: "test",
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("not a git repository") });
    expect(repository.get().proposals.find((p) => p.id === proposalId)?.status).toBe("controlled");
  });

  test("without a workspace the behavior is unchanged (branch strategy as before)", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/exec-plain/.dao"));
    const proposalId = await controlledProposal(repository);

    const result = await new ExecuteProposalUseCase({ repository, clock: systemClock }).execute({
      proposalId,
      actor: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.branch).toBe(result.plan.branchStrategy);
  });

  test("ship-path audit details keep their own text and gain the isolation facts", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/exec-ship/.dao"));
    const proposalId = await controlledProposal(repository);

    const workspace: ExecutionWorkspacePort = {
      prepare: async (proposal) => ({
        ok: true,
        branch: `dao/${proposal.id}-isolated-feature`,
        path: "/repo/.dao/worktrees/x",
      }),
    };

    const shipped = await new ShipProposalUseCase({ repository, clock: systemClock, workspace }).execute({
      proposalId,
      actor: "cli",
    });
    expect(shipped.ok).toBe(true);

    const audit = repository
      .get()
      .auditLog.filter((entry) => entry.proposalId === proposalId && entry.layer === "delivery")
      .at(-1);
    expect(audit?.details).toContain("shipped via dao_ship");
    expect(audit?.details).toContain(`dao/${proposalId}-isolated-feature`);
    expect(audit?.details).toContain("/repo/.dao/worktrees/x");
  });

  test("presentExecution renders the actual executed branch from the snapshot", async () => {
    const { presentExecution } = await import("../src/presenters/proposal.presenter.js");
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/exec-present/.dao"));
    const proposalId = await controlledProposal(repository);

    const workspace: ExecutionWorkspacePort = {
      prepare: async (proposal) => ({
        ok: true,
        branch: `dao/${proposal.id}-isolated-feature`,
        path: "/repo/.dao/worktrees/x",
      }),
    };
    const executed = await new ExecuteProposalUseCase({ repository, clock: systemClock, workspace }).execute({
      proposalId,
      actor: "test",
    });
    if (!executed.ok) throw new Error(executed.error);

    const rendered = presentExecution(executed);
    expect(rendered).toContain(`**Branch:** \`dao/${proposalId}-isolated-feature\``);
    expect(rendered).not.toContain(executed.plan.branchStrategy);
  });
});
