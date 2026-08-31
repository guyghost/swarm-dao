// ADR-003 rollout step 3 — opt-in integration test.
//
// EVOLUTION_IT=1 bun test packages/integration-tests/tests/sandbox-evolution.it.test.ts
//
// Proves the end-to-end bounded evolution path on a real container runtime:
// a git worktree is provisioned by GitWorkspace in sandbox mode (runtime
// probed first),
// then a trivial evolution (`sh -c` writing a file into /workspace) runs
// inside the container through the shared pure command builder. The worktree
// must contain the evolved file afterwards — the file boundary and the
// container boundary line up.

import { describe, expect, test } from "bun:test";
import { exec } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSandboxCommand } from "@guyghost/swarm-dao-core";
import { GitWorkspace } from "@guyghost/swarm-dao-core/adapters";
import type { CommandRunnerPort } from "@guyghost/swarm-dao-core/ports";

const execAsync = promisify(exec);
const EVOLUTION_IT = process.env.EVOLUTION_IT === "1";
const IMAGE = process.env.EVOLUTION_IMAGE ?? "alpine:latest";
const RUNTIME = process.env.EVOLUTION_RUNTIME === "docker" ? "docker" : "container";

function realRunner(): CommandRunnerPort {
  return {
    exec: async (command, options) => {
      try {
        const { stdout, stderr } = await execAsync(command, { cwd: options?.cwd, timeout: options?.timeout });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message ?? "command failed",
          exitCode: Number.isInteger(failure.code) ? (failure.code as number) : 1,
        };
      }
    },
  };
}

async function gitInitRepo(root: string): Promise<void> {
  // Local identity: CI images often have none (Copilot review on #85).
  await execAsync(
    `git init -q ${root} && git -C ${root} config user.email it@swarm-dao && ` +
      `git -C ${root} config user.name it && git -C ${root} commit -q --allow-empty -m seed`,
  );
}

describe.skipIf(!EVOLUTION_IT)("sandboxed evolution (EVOLUTION_IT=1)", () => {
  test("a trivial evolution lands in the sandboxed worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "evolution-it-"));
    try {
      await gitInitRepo(repo);
      const runner = realRunner();
      const workspace = new GitWorkspace({
        runner,
        repositoryRoot: repo,
        isolation: "sandbox",
        worktreeRoot: ".dao/worktrees",
        sandbox: { runtime: RUNTIME, image: IMAGE },
      });

      const prepared = await workspace.prepare({ id: 1, title: "Sandboxed evolution" });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.path).toContain(".dao/worktrees/1-sandboxed-evolution");

      const command = buildSandboxCommand(
        { runtime: RUNTIME, image: IMAGE, workDir: prepared.path ?? "" },
        "echo evolved > /workspace/evolved.txt",
      );
      // Promisified exec rejects on a non-zero exit: reaching this line is
      // itself the container outcome. The evidence is the evolved file below.
      await execAsync(command);

      const evolved = await readFile(`${prepared.path}/evolved.txt`, "utf8");
      expect(evolved.trim()).toBe("evolved");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
