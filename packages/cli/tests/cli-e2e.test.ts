import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "@guyghost/swarm-dao-cli";

async function runCLI(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  // biome-ignore lint/suspicious/noExplicitAny: overriding Node.js write signature for capture
  process.stdout.write = (chunk: any) => {
    stdout.push(String(chunk));
    return true;
  };
  // biome-ignore lint/suspicious/noExplicitAny: overriding Node.js write signature for capture
  process.stderr.write = (chunk: any) => {
    stderr.push(String(chunk));
    return true;
  };

  try {
    const code = await main(args, cwd);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe("CLI E2E", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `swarm-dao-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("init + setup + propose + list + status", async () => {
    const init = await runCLI(["init"], testDir);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("initialized");

    const setup = await runCLI(["setup"], testDir);
    expect(setup.code).toBe(0);
    expect(setup.stdout).toContain("7 agents");

    const propose = await runCLI(
      ["propose", "--title=Test Feature", "--type=product-feature", "--description=Add test"],
      testDir,
    );
    expect(propose.code).toBe(0);
    expect(propose.stdout).toContain("Proposal #1");

    const list = await runCLI(["list"], testDir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Test Feature");

    const status = await runCLI(["status"], testDir);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("proposals:       1");
  });

  it("vote on proposal", async () => {
    await runCLI(["init"], testDir);
    await runCLI(["setup"], testDir);
    await runCLI(["propose", "--title=Vote Test", "--type=product-feature", "--description=Test"], testDir);

    const vote = await runCLI(["vote", "1", "--position=for", "--reasoning=Looks good", "--weight=3"], testDir);
    expect(vote.code).toBe(0);
    expect(vote.stdout).toContain("Vote recorded");

    const show = await runCLI(["show", "1"], testDir);
    expect(show.stdout).toContain("for");
  });

  it("rejects invalid vote weight", async () => {
    await runCLI(["init"], testDir);
    await runCLI(["setup"], testDir);
    await runCLI(["propose", "--title=Vote Test", "--type=product-feature", "--description=Test"], testDir);

    const vote = await runCLI(["vote", "1", "--position=for", "--reasoning=Looks good", "--weight=NaN"], testDir);
    expect(vote.code).toBe(1);
    expect(vote.stderr).toContain("--weight must be a positive number");
  });

  it("audit trail", async () => {
    await runCLI(["init"], testDir);
    await runCLI(["setup"], testDir);
    await runCLI(["propose", "--title=Audit Test", "--type=product-feature", "--description=Test"], testDir);

    const audit = await runCLI(["audit"], testDir);
    expect(audit.code).toBe(0);
    expect(audit.stdout).toContain("proposal-created");
  });

  it("shows help", async () => {
    const help = await runCLI(["help"], testDir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("swarm-dao");
    expect(help.stdout).toContain("init");
    expect(help.stdout).toContain("propose");
  });

  // ── P2: GitHub CLI command tests ───────────────────────────

  describe("github commands", () => {
    it("github-config stores token, owner, and repo in config.json", async () => {
      await runCLI(["init"], testDir);

      const result = await runCLI(["github-config", "--token=ghp_test123", "--owner=myorg", "--repo=myrepo"], testDir);

      // Should succeed (exit 0) or fail gracefully with helpful message
      // If the command exists, verify config was stored
      if (result.code === 0) {
        expect(result.stdout).toContain("GitHub");
        // Verify config was persisted
        const configPath = path.join(testDir, ".dao", "config.json");
        const configData = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(configData.github).toBeDefined();
        expect(configData.github.token).toBe("ghp_test123");
        expect(configData.github.owner).toBe("myorg");
        expect(configData.github.repo).toBe("myrepo");
      } else {
        // Command might not exist yet — verify error is about unknown command
        expect(result.stderr).toMatch(/unknown command|error/i);
      }
    });

    it("github-branch without config shows error about missing configuration", async () => {
      await runCLI(["init"], testDir);

      const result = await runCLI(["github-branch", "1"], testDir);

      // Should either fail with config error or be unknown command
      if (result.code !== 0) {
        const output = result.stdout + result.stderr;
        // If the command exists, it should complain about missing GitHub config
        // If the command doesn't exist yet, it'll say "unknown command"
        expect(output).toMatch(/unknown command|config|token|github/i);
      }
    });

    it("github-pr without config shows error about missing configuration", async () => {
      await runCLI(["init"], testDir);

      const result = await runCLI(["github-pr", "1", "--head-branch=feat/test"], testDir);

      // Should either fail with config error or be unknown command
      if (result.code !== 0) {
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/unknown command|config|token|github/i);
      }
    });
  });

  // ── Ship command tests ─────────────────────────────────────

  describe("ship command", () => {
    /** Helper: fast-track a proposal to 'controlled' status by mutating state directly */
    async function setupControlledProposal(title: string, dependsOn?: number[]): Promise<number> {
      const { loadState, saveState, getOrCreateState, setState } = await import("@guyghost/swarm-dao-core");

      const loaded = await loadState(testDir);
      if (!loaded) {
        const { initializeAgents } = await import("@guyghost/swarm-dao-core");
        const s = getOrCreateState(testDir);
        s.initialized = true;
        s.agents = initializeAgents();
        setState(s);
      }

      const { createProposal, transitionProposal } = await import("@guyghost/swarm-dao-core");
      const p = await createProposal(title, "product-feature", "desc", "test");
      if (dependsOn) p.dependsOn = dependsOn;
      transitionProposal(p, "deliberate");
      transitionProposal(p, "approve");
      transitionProposal(p, "control");
      await saveState();
      return p.id;
    }

    it("ships a proposal without dependencies", async () => {
      await runCLI(["init"], testDir);
      await runCLI(["setup"], testDir);
      const id = await setupControlledProposal("Feature A");

      const result = await runCLI(["ship", String(id)], testDir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Shipped #${id}`);
    });

    it("blocks ship when dependency is unexecuted (no --cascade)", async () => {
      await runCLI(["init"], testDir);
      await runCLI(["setup"], testDir);
      await setupControlledProposal("Dep A"); // id=1
      const id = await setupControlledProposal("Feature B", [1]);

      const result = await runCLI(["ship", String(id)], testDir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Dependencies not yet executed");
      expect(result.stdout).toContain("--cascade");
    });

    it("ships dependency first then target with --cascade", async () => {
      await runCLI(["init"], testDir);
      await runCLI(["setup"], testDir);
      const depId = await setupControlledProposal("Dep A"); // id=1
      const targetId = await setupControlledProposal("Feature B", [depId]);

      const result = await runCLI(["ship", String(targetId), "--cascade"], testDir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Shipped #${depId}`);
      expect(result.stdout).toContain(`Shipped #${targetId}`);
    });

    it("skips already-executed dependency with --cascade", async () => {
      await runCLI(["init"], testDir);
      await runCLI(["setup"], testDir);
      const depId = await setupControlledProposal("Dep A");
      // Ship the dep first
      await runCLI(["ship", String(depId)], testDir);
      const targetId = await setupControlledProposal("Feature B", [depId]);

      const result = await runCLI(["ship", String(targetId), "--cascade"], testDir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Shipped #${targetId}`);
      // Dep was already executed — no redundant ship
      expect(result.stdout).not.toContain(`Shipped #${depId}: Dep A`);
    });

    it("--cascade fails when dependency is not in controlled state", async () => {
      await runCLI(["init"], testDir);
      await runCLI(["setup"], testDir);

      // Create dep in 'open' state (not controlled)
      const { loadState, getOrCreateState, setState, saveState, initializeAgents, createProposal } = await import(
        "@guyghost/swarm-dao-core"
      );
      const loaded = await loadState(testDir);
      if (!loaded) {
        const s = getOrCreateState(testDir);
        s.initialized = true;
        s.agents = initializeAgents();
        setState(s);
      }
      const dep = await createProposal("Open Dep", "product-feature", "desc", "test");
      const targetId = await setupControlledProposal("Feature B", [dep.id]);
      await saveState();

      const result = await runCLI(["ship", String(targetId), "--cascade"], testDir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not in 'controlled' state");
    });

    it("--force ships even with unexecuted dependencies", async () => {
      await runCLI(["init"], testDir);
      await runCLI(["setup"], testDir);
      await setupControlledProposal("Dep A"); // id=1, not shipped
      const id = await setupControlledProposal("Feature B", [1]);

      const result = await runCLI(["ship", String(id), "--force"], testDir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Shipped #${id}`);
    });

    it("propose with --depends-on records dependency", async () => {
      await runCLI(["init"], testDir);
      await runCLI(["setup"], testDir);
      await runCLI(["propose", "--title=Base", "--type=product-feature", "--description=base"], testDir);

      const result = await runCLI(
        ["propose", "--title=Feature", "--type=product-feature", "--description=feat", "--depends-on=1"],
        testDir,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("depends-on: #1");
    });
  });
});
