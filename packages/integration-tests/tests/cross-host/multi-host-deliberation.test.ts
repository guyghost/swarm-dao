import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  handleDaoControl,
  handleDaoDeliberate,
  handleDaoPropose,
  handleDaoRecordOutputs,
  handleDaoSetup,
  handleDaoShip,
} from "@guyghost/swarm-dao-core";
import { createMcpHostAdapter } from "@guyghost/swarm-dao-mcp";
import {
  agentContent,
  createSpawningHost,
  createWorkspace,
  proposalArgs,
  type Workspace,
} from "../support/fixtures.js";

describe("Cross-host: one governance state shared by several hosts", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await createWorkspace("cross-host");
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it("hands a proposal from an auto host to another host through persisted state", async () => {
    const pi = workspace.context(createSpawningHost("pi", { workDir: workspace.dir }));
    await handleDaoSetup(pi);
    await handleDaoPropose(proposalArgs(), workspace.repository);
    await handleDaoDeliberate(pi, 1);

    // A second host boots from the persisted state, without any shared memory.
    const reopened = await workspace.reload();
    const opencode = workspace.context(createSpawningHost("opencode", { workDir: workspace.dir }), {
      repository: reopened,
      controlToolName: "dao_check",
    });

    expect(reopened.get().proposals[0]?.status).toBe("approved");
    expect(await handleDaoControl(opencode, 1)).toContain("ALL GATES PASSED");
    await handleDaoShip(opencode, 1);

    const final = await workspace.reload();
    expect(final.get().proposals[0]?.status).toBe("executed");
    expect(final.get().auditLog.some((entry) => entry.actor === "opencode")).toBe(true);
  });

  it("reaches the same verdict on a manual (stdio) host as on an auto host", async () => {
    const autoWorkspace = await createWorkspace("cross-host-auto");
    try {
      const pi = autoWorkspace.context(createSpawningHost("pi", { workDir: autoWorkspace.dir }));
      await handleDaoSetup(pi);
      await handleDaoPropose(proposalArgs(), autoWorkspace.repository);
      await handleDaoDeliberate(pi, 1);

      // Stdio hosts (mcp/claude/codex/copilot) cannot spawn sub-agents: they get
      // a dispatch plan from dao_deliberate and push the outputs back manually.
      const mcp = workspace.context(createMcpHostAdapter(workspace.dir), { deliberationMode: "manual" });
      await handleDaoSetup(mcp);
      await handleDaoPropose(proposalArgs(), workspace.repository);
      const plan = await handleDaoDeliberate(mcp, 1);
      expect(plan).toContain("Dispatch");
      expect(workspace.repository.get().proposals[0]?.status).toBe("deliberating");

      await handleDaoRecordOutputs(
        mcp,
        1,
        workspace.repository.get().agents.map((agent) => ({
          agentId: agent.id,
          content: agentContent(agent.id, { vote: "for" }),
        })),
      );

      const manual = workspace.repository.get().proposals[0];
      const auto = autoWorkspace.repository.get().proposals[0];
      expect(manual?.status).toBe(auto?.status);
      expect(manual?.votes.map((vote) => vote.position)).toEqual(auto?.votes.map((vote) => vote.position) ?? []);
      expect(manual?.compositeScore?.weighted).toBe(auto?.compositeScore?.weighted ?? -1);
    } finally {
      await autoWorkspace.cleanup();
    }
  });

  it("keeps hosts isolated when they own different workspaces", async () => {
    const other = await createWorkspace("cross-host-isolated");
    try {
      const pi = workspace.context(createSpawningHost("pi", { workDir: workspace.dir }));
      const codex = other.context(createSpawningHost("codex", { workDir: other.dir }));

      await handleDaoSetup(pi);
      await handleDaoSetup(codex);
      await handleDaoPropose(proposalArgs({ title: "Only on pi" }), workspace.repository);

      expect(other.repository.get().proposals).toHaveLength(0);
      expect(await handleDaoControl(codex, 1)).toContain("not found");
    } finally {
      await other.cleanup();
    }
  });

  it("tallies a split swarm identically no matter which host ran it", async () => {
    const dissenting = (agentId: string) =>
      agentId === "architect" ? ({ vote: "against" } as const) : ({ vote: "for" } as const);

    const pi = workspace.context(createSpawningHost("pi", { replyFor: dissenting, workDir: workspace.dir }));
    await handleDaoSetup(pi);
    await handleDaoPropose(proposalArgs(), workspace.repository);
    await handleDaoDeliberate(pi, 1);
    const piProposal = workspace.repository.get().proposals[0];

    const claudeLike = await createWorkspace("cross-host-claude");
    try {
      const claude = claudeLike.context(
        createSpawningHost("claude", { replyFor: dissenting, workDir: claudeLike.dir }),
      );
      await handleDaoSetup(claude);
      await handleDaoPropose(proposalArgs(), claudeLike.repository);
      await handleDaoDeliberate(claude, 1);
      const claudeProposal = claudeLike.repository.get().proposals[0];

      expect(piProposal?.status).toBeDefined();
      expect(claudeProposal?.status).toBe(piProposal?.status);
      expect(claudeProposal?.votes.filter((vote) => vote.position === "against")).toHaveLength(1);
    } finally {
      await claudeLike.cleanup();
    }
  });
});
