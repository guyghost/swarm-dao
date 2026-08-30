// Host-tool wiring: execution isolation must apply to BOTH dao_execute and
// dao_ship (host shipping must not bypass a configured worktree), and the
// execute output must render the actual isolated branch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ControlProposalUseCase,
  CreateProposalUseCase,
  createInitialState,
  DEFAULT_AGENTS,
  DeliberateProposalUseCase,
  InitializeDaoUseCase,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { InMemoryDaoStateRepository } from "../src/adapters/persistence/in-memory-dao-state.repository.js";
import type { DaoToolContext } from "../src/host-tools/handlers.js";
import { handleDaoCheckEdit, handleDaoExecute, handleDaoShip } from "../src/host-tools/handlers.js";
import type { AgentOutput, HostAdapter } from "../src/types/index.js";

type ExecCall = { command: string; options?: { cwd?: string } };

/** Host whose exec records commands and simulates a successful git. */
function recordingHost(calls: ExecCall[]): HostAdapter {
  return {
    hostId: "wiring-test",
    spawnAgent: async ({ agent }): Promise<AgentOutput> => ({
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: "## Analysis\na\n## Vote\nfor\n## Reasoning\nr",
      durationMs: 0,
    }),
    spawnAgents: async () => [],
    log: async () => {},
    getWorkingDirectory: () => "/repo",
    readFile: async () => "",
    writeFile: async () => {},
    exec: async (command, options) => {
      calls.push({ command, options });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    hasCapability: () => true,
  };
}

describe("host tools: execution isolation wiring", () => {
  let daoRoot: string;

  beforeAll(async () => {
    daoRoot = path.join(await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-wiring-")), ".dao");
    await fs.mkdir(daoRoot, { recursive: true });
    await fs.writeFile(
      path.join(daoRoot, "config.json"),
      JSON.stringify({ mode: "opt-in", execution: { isolation: "worktree" } }),
    );
  });

  afterAll(async () => {
    await fs.rm(path.dirname(daoRoot), { recursive: true, force: true });
  });

  async function controlledRepository(): Promise<{ repository: InMemoryDaoStateRepository; proposalId: number }> {
    const repository = new InMemoryDaoStateRepository(createInitialState(daoRoot));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
    const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "Wired Feature",
      type: "product-feature",
      description: "d",
      proposedBy: "test",
    });
    if (!created.ok) throw new Error(created.error);
    const host = recordingHost([]);
    const deliberation = await new DeliberateProposalUseCase({ repository, worker: host, clock: systemClock }).execute({
      proposalId: created.proposal.id,
    });
    if (!deliberation.ok) throw new Error(deliberation.error);
    const control = await new ControlProposalUseCase({ repository, clock: systemClock }).execute({
      proposalId: created.proposal.id,
    });
    if (!control.ok) throw new Error(control.error);
    return { repository, proposalId: created.proposal.id };
  }

  function context(repository: InMemoryDaoStateRepository, host: HostAdapter): DaoToolContext {
    return {
      adapter: host,
      workDir: "/repo",
      deliberationMode: "auto",
      controlToolName: "dao_check",
      repository,
    };
  }

  test("dao_execute provisions the worktree and reports the isolated branch", async () => {
    const { repository, proposalId } = await controlledRepository();
    const calls: ExecCall[] = [];
    const host = recordingHost(calls);

    const output = await handleDaoExecute(context(repository, host), proposalId);

    expect(calls.some((call) => call.command.startsWith("git worktree add"))).toBe(true);
    expect(calls[0]?.command).toBe(`git -C .dao/worktrees/${proposalId}-wired-feature rev-parse --abbrev-ref HEAD`);
    expect(calls[1]?.command).toBe(
      `git worktree add -b dao/${proposalId}-wired-feature .dao/worktrees/${proposalId}-wired-feature`,
    );
    expect(calls[1]?.options?.cwd).toBe("/repo");
    expect(output).toContain(`**Branch:** \`dao/${proposalId}-wired-feature\``);
    expect(repository.get().proposals.find((p) => p.id === proposalId)?.status).toBe("executed");
  });

  test("dao_ship honours the same isolation (host shipping must not bypass it)", async () => {
    const { repository, proposalId } = await controlledRepository();
    const calls: ExecCall[] = [];
    const host = recordingHost(calls);

    const output = await handleDaoShip(context(repository, host), proposalId);

    expect(calls.some((call) => call.command.startsWith("git worktree add"))).toBe(true);
    expect(output).toContain(`#${proposalId}`);
    expect(repository.get().proposals.find((p) => p.id === proposalId)?.status).toBe("executed");
    const audit = repository
      .get()
      .auditLog.filter((entry) => entry.proposalId === proposalId && entry.layer === "delivery")
      .at(-1);
    expect(audit?.details).toContain(`dao/${proposalId}-wired-feature`);
  });

  test("dao_check_edit applies the configured mode from the project config", async () => {
    const enforceRoot = path.join(await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-editgate-")), ".dao");
    await fs.mkdir(enforceRoot, { recursive: true });
    await fs.writeFile(
      path.join(enforceRoot, "config.json"),
      JSON.stringify({ mode: "enforce", criticalPaths: ["src/auth/**", "src/payment/**"] }),
    );
    try {
      const repository = new InMemoryDaoStateRepository(createInitialState(enforceRoot));
      await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
      const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
        title: "Auth Refactor",
        type: "technical-change",
        description: "d",
        proposedBy: "test",
        affectedPaths: ["src/auth/**"],
      });
      if (!created.ok) throw new Error(created.error);
      // Approved via the machine (deliberation → approved) — no control needed.
      const host = recordingHost([]);
      const deliberation = await new DeliberateProposalUseCase({
        repository,
        worker: host,
        clock: systemClock,
      }).execute({ proposalId: created.proposal.id });
      if (!deliberation.ok) throw new Error(deliberation.error);

      const calls: ExecCall[] = [];
      const ctx = {
        adapter: recordingHost(calls),
        workDir: "/repo",
        deliberationMode: "auto" as const,
        controlToolName: "dao_check" as const,
        repository,
      };

      // Covered critical path → allowed; uncovered critical path → blocked.
      const decision = await handleDaoCheckEdit(ctx, ["src/auth/login.ts", "src/payment/charge.ts"]);
      expect(decision).toContain("src/auth/login.ts");
      expect(decision).toContain("#" + created.proposal.id);
      expect(decision).toContain("Blocked");
      expect(decision).toContain("src/payment/charge.ts");

      // Empty input is rejected with guidance.
      const empty = await handleDaoCheckEdit(ctx, []);
      expect(empty).toContain("No paths provided");
    } finally {
      await fs.rm(path.dirname(enforceRoot), { recursive: true, force: true });
    }
  });

  test("unsafe isolation config blocks host shipping without running commands", async () => {
    const unsafeRoot = path.join(await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-unsafe-")), ".dao");
    await fs.mkdir(unsafeRoot, { recursive: true });
    await fs.writeFile(
      path.join(unsafeRoot, "config.json"),
      JSON.stringify({ execution: { isolation: "worktree", worktreeRoot: "; rm -rf /" } }),
    );
    try {
      const repository = new InMemoryDaoStateRepository(createInitialState(unsafeRoot));
      await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
      const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
        title: "Unsafe Feature",
        type: "product-feature",
        description: "d",
        proposedBy: "test",
      });
      if (!created.ok) throw new Error(created.error);
      const host = recordingHost([]);
      const deliberation = await new DeliberateProposalUseCase({
        repository,
        worker: host,
        clock: systemClock,
      }).execute({ proposalId: created.proposal.id });
      if (!deliberation.ok) throw new Error(deliberation.error);
      const control = await new ControlProposalUseCase({ repository, clock: systemClock }).execute({
        proposalId: created.proposal.id,
      });
      if (!control.ok) throw new Error(control.error);

      const calls: ExecCall[] = [];
      const output = await handleDaoShip(context(repository, recordingHost(calls)), created.proposal.id);

      expect(calls).toHaveLength(0);
      expect(output).toContain("invalid execution isolation config");
      expect(repository.get().proposals.find((p) => p.id === created.proposal.id)?.status).toBe("controlled");
    } finally {
      await fs.rm(path.dirname(unsafeRoot), { recursive: true, force: true });
    }
  });
});
