// E2E: execution isolation against a real git repository.
//
// Proves the swarm-forge-style worktree mechanics end to end:
// `git worktree add` carves an isolated directory per proposal, the branch
// survives re-preparation (retry), and the execution snapshot carries the
// real branch while the proposal machine does the state transitions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOutput, HostAdapter, Proposal } from "@guyghost/swarm-dao-core";
import {
  ControlProposalUseCase,
  CreateProposalUseCase,
  createInitialState,
  DEFAULT_AGENTS,
  DeliberateProposalUseCase,
  ExecuteProposalUseCase,
  GitWorkspace,
  InitializeDaoUseCase,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { InMemoryDaoStateRepository } from "@guyghost/swarm-dao-core/adapters";

const execAsync = promisify(exec);

const runner = {
  exec: async (command: string, options?: { cwd?: string; timeout?: number }) => {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: options?.cwd, timeout: options?.timeout });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
    }
  },
};

const approvingHost: HostAdapter = {
  hostId: "e2e",
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

describe("E2E: Execution worktree isolation", () => {
  let repoDir: string;
  let workspace: GitWorkspace;

  beforeAll(async () => {
    repoDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-worktree-"));
    await execAsync("git init -b main", { cwd: repoDir });
    await execAsync('git config user.email "dao@test"', { cwd: repoDir });
    await execAsync('git config user.name "dao-test"', { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, "README.md"), "# test\n");
    await execAsync("git add . && git commit -m init", { cwd: repoDir });

    workspace = new GitWorkspace({ runner, repositoryRoot: repoDir, isolation: "worktree" });
  });

  afterAll(async () => {
    // Detach worktrees before removing the repository (git refuses to delete
    // a directory containing registered worktrees).
    await runner.exec("git worktree prune", { cwd: repoDir }).catch(() => undefined);
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("prepare carves a real worktree with its own branch", async () => {
    const result = await workspace.prepare({ id: 1, title: "Isolated Feature" } as Pick<Proposal, "id" | "title">);
    expect(result.ok).toBe(true);
    if (!result.ok || result.path === null) throw new Error("expected an isolated worktree path");

    const stat = await fs.stat(result.path);
    expect(stat.isDirectory()).toBe(true);
    const readme = await fs.readFile(path.join(result.path, "README.md"), "utf8");
    expect(readme).toContain("# test");

    const branches = await execAsync("git branch --list dao/1-isolated-feature", { cwd: repoDir });
    expect(branches.stdout).toContain("dao/1-isolated-feature");
  });

  test("re-preparing attaches to the existing branch (retry path)", async () => {
    const result = await workspace.prepare({ id: 1, title: "Isolated Feature" } as Pick<Proposal, "id" | "title">);
    expect(result.ok).toBe(true);
  });

  test("full lifecycle records the isolated branch in the execution snapshot", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState(path.join(repoDir, ".dao")));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });

    const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "Isolated Feature",
      type: "product-feature",
      description: "d",
      proposedBy: "e2e",
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

    const executed = await new ExecuteProposalUseCase({ repository, clock: systemClock, workspace }).execute({
      proposalId: created.proposal.id,
      actor: "e2e",
    });
    if (!executed.ok) throw new Error(executed.error);

    // The proposal re-used id 1 whose worktree already existed: the snapshot
    // still records the deterministic isolated branch, and the proposal
    // reached `executed` through the machine.
    expect(executed.snapshot.branch).toBe("dao/1-isolated-feature");
    expect(executed.proposal.status).toBe("executed");
  });

  test("preparation fails cleanly outside a git repository", async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-nogit-"));
    try {
      const bare = new GitWorkspace({ runner, repositoryRoot: outside, isolation: "worktree" });
      const result = await bare.prepare({ id: 9, title: "Nowhere" } as Pick<Proposal, "id" | "title">);
      expect(result.ok).toBe(false);
      if (!result.ok) return;
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
