// Unit tests for the herdr host adapter: workspace/agent lifecycle command
// construction, name sanitization, JSON parsing, prompt quoting, state
// handling, and cleanup — with a fake herdr runner.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DAOAgent, Proposal } from "@guyghost/swarm-dao-core";
import { createInitialState } from "@guyghost/swarm-dao-core";
import { createHerdrHostAdapter, herdrAgentName, sanitizeHerdrName, stripEchoedVoteTemplates } from "../src/adapter.js";

type Call = { command: string; options?: { cwd?: string } };
type Response = { stdout?: string; stderr?: string; exitCode: number };

const WORKSPACE_CREATED = JSON.stringify({
  id: "cli:workspace:create",
  result: {
    root_pane: { pane_id: "w9:p1", workspace_id: "w9" },
    workspace: { workspace_id: "w9", label: "swarm-dao-p1-critic" },
    type: "workspace_created",
  },
});

const AGENT_SETTLED = (status: string) =>
  JSON.stringify({ id: "cli:agent:prompt", result: { agent: { name: "x", status }, type: "ok" } });

function fakeHerdr(responses: Response[]) {
  const calls: Call[] = [];
  let index = 0;
  let readOutput = "## Analysis\na\n## Vote\nfor\n## Reasoning\nr";
  const api = {
    calls,
    pane(content: string) {
      readOutput = content;
    },
    runner: {
      exec: async (command: string, options?: { cwd?: string }) => {
        calls.push({ command, options });
        if (command.includes("agent read")) {
          return { stdout: readOutput, stderr: "", exitCode: 0 };
        }
        const response = responses[Math.min(index++, responses.length - 1)];
        if (!response) throw new Error("unexpected exec call");
        return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
      },
    },
  };
  return api;
}

function agent(id: string): DAOAgent {
  return { id, name: `Agent ${id}`, role: "r", description: "d", weight: 1, systemPrompt: `PROMPT-${id}` };
}

function proposal(id: number): Proposal {
  return {
    id,
    title: "Herdr Feature",
    type: "product-feature",
    description: "d",
    proposedBy: "t",
    status: "deliberating",
    votes: [],
    agentOutputs: [],
    ...createInitialState("/tmp/.dao"),
  } as unknown as Proposal;
}

describe("herdr host adapter", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-herdr-unit-"));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("full lifecycle: workspace → agent start → prompt --wait → read → workspace close", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 }, // workspace create
      { stdout: AGENT_SETTLED("working"), exitCode: 0 }, // agent start
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 }, // prompt --wait
      { exitCode: 0 }, // workspace close
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });

    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(1),
      systemPrompt: "PROMPT-critic",
    });

    const commands = fake.calls.map((call) => call.command);
    expect(commands[0]).toContain("herdr workspace create");
    expect(commands[0]).toContain("--cwd");
    expect(commands[0]).toContain("--no-focus");
    expect(commands[1]).toMatch(/herdr agent start swarm-dao-p1-critic-\w{4} --kind pi --pane w9:p1/);
    expect(commands[1]).toContain("--timeout");
    expect(commands[2]).toMatch(/herdr agent prompt swarm-dao-p1-critic-\w{4} /);
    expect(commands[2]).toContain("PROMPT-critic");
    expect(commands[2]).toContain("--wait");
    expect(commands[3]).toMatch(/herdr agent read swarm-dao-p1-critic-\w{4} --source recent-unwrapped/);
    expect(commands[4]).toContain("herdr workspace close w9");

    expect(output.error).toBeUndefined();
    expect(output.content).toContain("## Vote");
    expect(output.agentId).toBe("critic");
  });

  test("multi-line prompts are passed as a single POSIX-quoted argument", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      { exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });

    await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(2),
      systemPrompt: "line one\nline 'quoted' \"text\"\nline three",
    });

    const promptCommand = fake.calls.find((call) => call.command.includes("agent prompt"));
    // The whole prompt is one single-quoted argument with embedded quotes escaped.
    const quoted = promptCommand?.command.match(/agent prompt \S+ '([\s\S]*)' --wait/)?.[1];
    expect(quoted).toContain("line one");
    expect(quoted).toContain("'\\''quoted'\\''");
    expect(quoted).toContain("line three");
  });

  test("a blocked agent surfaces as an error, never as a vote", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stdout: AGENT_SETTLED("blocked"), exitCode: 0 },
      { exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "claude" });

    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(3),
      systemPrompt: "P",
    });
    expect(output.error).toContain("blocked");
    // Cleanup still runs.
    expect(fake.calls.some((call) => call.command.includes("workspace close"))).toBe(true);
  });

  test("a server error fails fast with the herdr error code", async () => {
    const fake = fakeHerdr([
      {
        stderr: JSON.stringify({ error: { code: "server_unavailable", message: "no server" } }),
        exitCode: 1,
      },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });

    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(4),
      systemPrompt: "P",
    });
    expect(output.error).toContain("server_unavailable");
  });

  test("a prompt timeout surfaces the deterministic timeout error", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stderr: JSON.stringify({ error: { code: "timeout", message: "wait timed out" } }), exitCode: 1 },
      { exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi", timeoutMs: 60_000 });

    const output = await adapter.spawnAgent({
      agent: agent("slow"),
      proposal: proposal(5),
      systemPrompt: "P",
    });
    expect(output.error).toContain("timed out");
    expect(fake.calls.some((call) => call.command.includes("workspace close"))).toBe(true);
  });

  test("the per-call timeoutMs overrides the adapter default", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      { exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi", timeoutMs: 300_000 });
    await adapter.spawnAgent({
      agent: agent("x"),
      proposal: proposal(6),
      systemPrompt: "P",
      timeoutMs: 120_000,
    });
    const promptCommand = fake.calls.find((call) => call.command.includes("agent prompt"));
    expect(promptCommand?.command).toContain("--timeout 120000");
  });

  test("missing kind fails with a copy-pasteable setup message", async () => {
    const fake = fakeHerdr([{ exitCode: 0 }]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner });
    const output = await adapter.spawnAgent({ agent: agent("any"), proposal: proposal(7), systemPrompt: "P" });
    expect(output.error).toContain("herdr.kind");
    expect(output.error).toContain('"herdr": { "kind": "pi" }');
  });

  test("keepPanes keeps the workspace for operator inspection", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi", keepPanes: true });
    await adapter.spawnAgent({ agent: agent("critic"), proposal: proposal(8), systemPrompt: "P" });
    expect(fake.calls.some((call) => call.command.includes("workspace close"))).toBe(false);
  });

  test("hostile agent ids are sanitized into valid herdr names", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      { exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });
    await adapter.spawnAgent({
      agent: agent("../Weird/ID 99"),
      proposal: proposal(9),
      systemPrompt: "P",
    });
    const start = fake.calls.find((call) => call.command.includes("agent start"));
    expect(start?.command).toContain("--kind pi --pane");
    expect(start?.command).toMatch(/agent start swarm-dao-p9-weird-id-99-\w{4} /);
  });

  test("readFile/writeFile are contained under workDir and reject asynchronously", async () => {
    const fake = fakeHerdr([{ exitCode: 0 }]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });
    await fs.mkdir(path.join(workDir, "notes"), { recursive: true });
    await adapter.writeFile("notes/inner.txt", "ok");
    expect(await adapter.readFile("notes/inner.txt")).toBe("ok");
    await expect(adapter.writeFile("../outside.txt", "x")).rejects.toThrow("escapes");
    await expect(adapter.readFile("/etc/passwd")).rejects.toThrow("escapes");
  });

  test("spawnAgents fans out one workspace per agent", async () => {
    const responses: Response[] = [];
    for (let i = 0; i < 12; i++) {
      responses.push(
        i % 4 === 0 ? { stdout: WORKSPACE_CREATED, exitCode: 0 } : { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      );
    }
    const fake = fakeHerdr(responses);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });

    const outputs = await adapter.spawnAgents({
      agents: [agent("a"), agent("b"), agent("c")],
      proposal: proposal(10),
      maxConcurrent: 3,
    });
    expect(outputs).toHaveLength(3);
    expect(fake.calls.filter((call) => call.command.includes("workspace create")).length).toBe(3);
  });

  test("herdr names satisfy the [a-z][a-z0-9_-]{0,31} contract", () => {
    expect(sanitizeHerdrName("critic/risk agent")).toBe("critic-risk-agent");
    expect(sanitizeHerdrName("../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeHerdrName("123numeric")).toMatch(/^[a-z]/);
    expect(sanitizeHerdrName("A_VERY_LONG_AGENT_IDENTIFIER_EXCEEDING_LIMITS")).toHaveLength(32);
    expect(sanitizeHerdrName("")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  test("long ids never collide: the agent-specific hash always survives truncation", () => {
    const prefix = "a-very-long-custom-prefix";
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const name = herdrAgentName(prefix, 123456789, `agent-with-a-very-long-identifier-${i}`);
      expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      names.add(name);
    }
    expect(names.size).toBe(20);
    // Different agents on the same proposal never share a name.
    expect(herdrAgentName("swarm-dao", 1, "strategist")).not.toBe(herdrAgentName("swarm-dao", 1, "critic"));
  });

  test("echoed vote templates are stripped from the harvest (tally poisoning)", async () => {
    const transcript = [
      "## Analysis",
      "[Your analysis]", // echoed charter template
      "",
      "## Vote",
      "for | against | abstain", // ← the tally would parse this as "for"!
      "",
      "## Reasoning",
      "[Why you voted this way]",
      "",
      "— the agent's real answer —",
      "## Analysis",
      "Solid but small.",
      "",
      "## Vote",
      "against",
      "",
      "## Reasoning",
      "Too broad for now.",
    ].join("\n");
    const cleaned = stripEchoedVoteTemplates(transcript);
    expect(cleaned).not.toContain("for | against | abstain");
    expect(cleaned).toContain("against");
    // And through the adapter: the harvested content is template-free.
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      { exitCode: 0 },
    ]);
    fake.pane(transcript);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });
    const output = await adapter.spawnAgent({ agent: agent("critic"), proposal: proposal(11), systemPrompt: "P" });
    expect(output.content).not.toContain("for | against | abstain");
    // The real vote survives and is now the ONLY votable line.
    const { parseVoteFromOutput } = await import("@guyghost/swarm-dao-core");
    const vote = parseVoteFromOutput("critic", "Critic", 1, output.content);
    expect(vote?.position).toBe("against");
  });

  test("durations reflect the actual agent runtime, not setup time", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      { exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });
    // Simulate the agent taking ~40ms across the herdr commands.
    const originalExec = fake.runner.exec;
    fake.runner.exec = async (command: string, options?: { cwd?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalExec(command, options);
    };
    const output = await adapter.spawnAgent({ agent: agent("slow"), proposal: proposal(12), systemPrompt: "P" });
    // Duration covers the herdr command runtime (4 simulated delays ≥ 10ms each).
    expect(output.durationMs).toBeGreaterThanOrEqual(30);
  });

  test("a hostile kind is refused, never interpolated into the shell", async () => {
    const fake = fakeHerdr([{ exitCode: 0 }]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi; rm -rf /" });
    const output = await adapter.spawnAgent({ agent: agent("x"), proposal: proposal(13), systemPrompt: "P" });
    expect(output.error).toContain("not a valid agent kind");
    expect(fake.calls.every((call) => !call.command.includes("rm -rf"))).toBe(true);
  });

  test("agentArgs are quoted as single argv elements", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      { stdout: AGENT_SETTLED("working"), exitCode: 0 },
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 },
      { exitCode: 0 },
    ]);
    const adapter = createHerdrHostAdapter({
      workDir,
      runner: fake.runner,
      kind: "codex",
      agentArgs: ["-m", "o3; touch /tmp/pwned"],
    });
    await adapter.spawnAgent({ agent: agent("x"), proposal: proposal(14), systemPrompt: "P" });
    const start = fake.calls.find((call) => call.command.includes("agent start"));
    expect(start?.command).toContain("-- '-m' 'o3; touch /tmp/pwned'");
  });

  test("symlinks cannot bypass workspace containment", async () => {
    const fake = fakeHerdr([{ exitCode: 0 }]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi" });
    const outside = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-herdr-out-"));
    try {
      await fs.symlink(outside, path.join(workDir, "escape"));
      await expect(adapter.readFile("escape/secret.txt")).rejects.toThrow("escapes");
      await expect(adapter.writeFile("escape/secret.txt", "x")).rejects.toThrow("escapes");
    } finally {
      await fs.rm(path.join(workDir, "escape"), { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
