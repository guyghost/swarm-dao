// Unit tests for the herdr host adapter: workspace/agent lifecycle command
// construction, name sanitization, JSON parsing, prompt quoting, state
// handling, and cleanup — with a fake herdr runner.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DAOAgent, Proposal } from "@guyghost/swarm-dao-core";
import { createInitialState } from "@guyghost/swarm-dao-core";
import {
  createChildWorkspace,
  createHerdrHostAdapter,
  herdrAgentName,
  herdrParentWorkspaceId,
  sanitizeHerdrName,
  stripEchoedVoteTemplates,
} from "../src/adapter.js";

// Hermetic unit tests: child-session linkage defaults come from the host
// environment (HERDR_WORKSPACE_ID when this process runs inside a herdr
// pane) — pin it off; linkage tests pass explicit parent ids.
process.env.HERDR_ENV = "0";
delete process.env.HERDR_WORKSPACE_ID;

type Call = { argv: string[]; options?: { cwd?: string } };

/** Shell-free assertions helper: the joined form is for `toContain` checks only —
 * the adapter never builds a shell line (argv elements stay verbatim). */
const line = (call: Call): string => call.argv.join(" ");
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
  JSON.stringify({
    id: "cli:agent:prompt",
    result: { agent: { name: "x", agent_status: status }, type: "agent_prompted" },
  });

const AGENT_INFO = (status: string) =>
  JSON.stringify({ id: "cli:agent:get", result: { agent: { name: "x", agent_status: status }, type: "agent_info" } });

const WORKTREE_OPENED = JSON.stringify({
  id: "cli:worktree:open",
  result: {
    root_pane: { pane_id: "w3:p1", workspace_id: "w3" },
    workspace: { workspace_id: "w3", label: "child" },
    type: "worktree_opened",
  },
});

const WORKSPACE_INFO = JSON.stringify({
  id: "cli:workspace:get",
  result: { type: "workspace_info", workspace: { workspace_id: "wP", label: "parent-label" } },
});

const PROMPT_STALLED = {
  stderr: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "no state change within 5000 ms" } }),
  exitCode: 1,
};

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
      exec: async (argv: readonly string[], options?: { cwd?: string }) => {
        calls.push({ argv: [...argv], options });
        if (argv[2] === "read") {
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

    const commands = fake.calls.map((call) => line(call));
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

  test("multi-line prompts are passed as a single verbatim argv element (never shell-interpreted)", async () => {
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

    // The whole prompt is ONE argv element, verbatim — no shell sees it, so
    // quotes/newlines need no escaping at all.
    const promptCommand = fake.calls.find((call) => call.argv[2] === "prompt");
    expect(promptCommand?.argv[4]).toBe("line one\nline 'quoted' \"text\"\nline three");
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
    expect(fake.calls.some((call) => line(call).includes("workspace close"))).toBe(true);
  });

  test("agent start retries on the same pane while herdr reports agent_pane_busy", async () => {
    const BUSY = JSON.stringify({ error: { code: "agent_pane_busy", message: "pane not at prompt" } });
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 }, // workspace create
      { stderr: BUSY, exitCode: 1 }, // agent start: fresh pane not at prompt yet
      { stdout: AGENT_SETTLED("working"), exitCode: 0 }, // agent start retry: ready
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 }, // prompt --wait
      { exitCode: 0 }, // workspace close
    ]);
    const adapter = createHerdrHostAdapter({
      workDir,
      runner: fake.runner,
      kind: "pi",
      readinessRetryDelayMs: 0,
    });

    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(6),
      systemPrompt: "P",
    });

    const starts = fake.calls.filter((call) => call.argv[2] === "start");
    expect(starts.length).toBe(2);
    for (const call of starts) {
      expect(call.argv).toContain("w9:p1"); // same pane across retries
      expect(line(call)).toMatch(/herdr agent start swarm-dao-p6-critic-\w{4}/); // same agent
    }
    expect(fake.calls.filter((call) => call.argv[2] === "create").length).toBe(1); // no attempt burned
    expect(output.error).toBeUndefined();
  });

  test("agent start failures other than agent_pane_busy are not retried on the pane", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 },
      {
        stderr: JSON.stringify({ error: { code: "unsupported_agent_kind", message: "nope" } }),
        exitCode: 1,
      },
      { exitCode: 0 }, // workspace close
    ]);
    const adapter = createHerdrHostAdapter({
      workDir,
      runner: fake.runner,
      kind: "pi",
      readinessRetryDelayMs: 0,
    });

    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(7),
      systemPrompt: "P",
    });

    expect(output.error).toContain("unsupported_agent_kind");
    expect(fake.calls.filter((call) => call.argv[2] === "start").length).toBe(1);
  });

  test("a stalled prompt whose agent came alive waits for settle (no re-prompt)", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 }, // workspace create
      { stdout: AGENT_SETTLED("working"), exitCode: 0 }, // agent start
      PROMPT_STALLED, // prompt --wait: herdr missed the 5 s state change
      { stdout: AGENT_INFO("working"), exitCode: 0 }, // grace-poll: prompt took effect
      { stdout: AGENT_INFO("idle"), exitCode: 0 }, // agent wait: settled
      { exitCode: 0 }, // workspace close
    ]);
    const adapter = createHerdrHostAdapter({
      workDir,
      runner: fake.runner,
      kind: "pi",
      stalledGraceMs: 0,
      stalledPollIntervalMs: 0,
    });

    const output = await adapter.spawnAgent({ agent: agent("critic"), proposal: proposal(8), systemPrompt: "P" });

    expect(output.error).toBeUndefined();
    expect(fake.calls.filter((call) => call.argv[2] === "prompt").length).toBe(1); // no double submission
    expect(fake.calls.filter((call) => call.argv[2] === "get").length).toBe(1);
    expect(fake.calls.filter((call) => call.argv[2] === "wait").length).toBe(1);
  });

  test("a stalled prompt whose agent stayed idle is re-prompted exactly once", async () => {
    const fake = fakeHerdr([
      { stdout: WORKSPACE_CREATED, exitCode: 0 }, // workspace create
      { stdout: AGENT_SETTLED("working"), exitCode: 0 }, // agent start
      PROMPT_STALLED, // first prompt stalled
      { stdout: AGENT_INFO("idle"), exitCode: 0 }, // grace-poll: still idle → swallowed
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 }, // re-prompt: settled
      { exitCode: 0 }, // workspace close
    ]);
    const adapter = createHerdrHostAdapter({
      workDir,
      runner: fake.runner,
      kind: "pi",
      stalledGraceMs: 0,
      stalledPollIntervalMs: 0,
    });

    const output = await adapter.spawnAgent({ agent: agent("critic"), proposal: proposal(9), systemPrompt: "P" });

    expect(output.error).toBeUndefined();
    expect(fake.calls.filter((call) => call.argv[2] === "prompt").length).toBe(2);
    expect(fake.calls.filter((call) => call.argv[2] === "wait").length).toBe(0);
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
    expect(fake.calls.some((call) => line(call).includes("workspace close"))).toBe(true);
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
    const promptCommand = fake.calls.find((call) => line(call).includes("agent prompt"));
    expect(line(promptCommand ?? { argv: [] })).toContain("--timeout 120000");
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
    expect(fake.calls.some((call) => line(call).includes("workspace close"))).toBe(false);
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
    const start = fake.calls.find((call) => call.argv[2] === "start");
    expect(line(start ?? { argv: [] })).toContain("--kind pi --pane");
    expect(start?.argv[3]).toMatch(/^swarm-dao-p9-weird-id-99-\w{4}$/);
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
    expect(fake.calls.filter((call) => line(call).includes("workspace create")).length).toBe(3);
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
    fake.runner.exec = async (argv: readonly string[], options?: { cwd?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalExec(argv, options);
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
    expect(fake.calls.every((call) => !line(call).includes("rm -rf"))).toBe(true);
  });

  test("agentArgs ride behind the separator as raw argv elements", async () => {
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
    const start = fake.calls.find((call) => call.argv[2] === "start");
    // agent args ride behind herdr's `--` separator as raw argv elements.
    expect(start?.argv.slice(-3)).toEqual(["--", "-m", "o3; touch /tmp/pwned"]);
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

  test("spawnAgent opens worktree children as workspaces linked to the parent session", async () => {
    // workDir carries a .git FILE → registered git worktree checkout.
    await fs.writeFile(path.join(workDir, ".git"), "gitdir: /tmp/elsewhere/.git/worktrees/probe\n");
    const fake = fakeHerdr([
      { stdout: WORKTREE_OPENED, exitCode: 0 }, // worktree open
      { stdout: "{}", exitCode: 0 }, // agent start
      { stdout: AGENT_SETTLED("idle"), exitCode: 0 }, // prompt --wait
      { exitCode: 0 }, // workspace close
    ]);
    const adapter = createHerdrHostAdapter({ workDir, runner: fake.runner, kind: "pi", parentWorkspaceId: "wP" });
    await adapter.spawnAgent({ agent: agent("critic"), proposal: proposal(1), systemPrompt: "PROMPT-critic" });
    const commands = fake.calls.map((call) => line(call));
    expect(commands[0]).toContain("herdr worktree open");
    expect(commands[0]).toContain("--workspace wP");
    expect(commands[0]).toContain(`--path ${workDir}`);
    expect(commands[0]).toContain("--no-focus");
    expect(commands.filter((command) => command.includes("workspace create"))).toEqual([]);
    // The agent lifecycle continues inside the opened (linked) workspace.
    expect(commands[1]).toContain("--pane w3:p1");
    expect(commands[4]).toContain("herdr workspace close w3");
    await fs.rm(path.join(workDir, ".git"), { force: true });
  });
});

describe("child workspace linkage (parent herdr session)", () => {
  let plainDir: string;
  let worktreeDir: string;

  beforeAll(async () => {
    plainDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-herdr-plain-"));
    worktreeDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-herdr-wtree-"));
    // A registered worktree checkout carries a .git FILE, not a directory.
    await fs.writeFile(path.join(worktreeDir, ".git"), "gitdir: /tmp/elsewhere/.git/worktrees/probe\n");
  });

  afterAll(async () => {
    await fs.rm(plainDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  const recorder = () => {
    const calls: Call[] = [];
    return {
      calls,
      runner: {
        exec: async (argv: readonly string[]) => {
          calls.push({ argv: [...argv] });
          if (argv[2] === "open") return { stdout: WORKTREE_OPENED, stderr: "", exitCode: 0 };
          if (argv[2] === "create") return { stdout: WORKSPACE_CREATED, stderr: "", exitCode: 0 };
          if (argv[2] === "get") return { stdout: WORKSPACE_INFO, stderr: "", exitCode: 0 };
          return { stdout: "{}", stderr: "", exitCode: 0 };
        },
      },
    };
  };

  test("env detection: HERDR_ENV=1 + HERDR_WORKSPACE_ID, otherwise none", () => {
    expect(herdrParentWorkspaceId({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wW" } as never)).toBe("wW");
    expect(herdrParentWorkspaceId({ HERDR_ENV: "0", HERDR_WORKSPACE_ID: "wW" } as never)).toBeUndefined();
    expect(herdrParentWorkspaceId({} as never)).toBeUndefined();
  });

  test("worktree checkout + parent → worktree open nested under the parent", async () => {
    const fake = recorder();
    const result = await createChildWorkspace(fake.runner, {
      workDir: worktreeDir,
      label: "child",
      parentWorkspaceId: "wP",
    });
    expect(result).toEqual({ ok: true, paneId: "w3:p1", workspaceId: "w3" });
    expect(fake.calls).toHaveLength(1);
    const argv = fake.calls[0].argv;
    expect(argv.slice(0, 3)).toEqual(["herdr", "worktree", "open"]);
    expect(argv).toContain("--workspace");
    expect(argv[argv.indexOf("--workspace") + 1]).toBe("wP");
    expect(argv[argv.indexOf("--path") + 1]).toBe(worktreeDir);
    expect(argv[argv.indexOf("--label") + 1]).toBe("child");
    expect(argv).toContain("--no-focus");
  });

  test("worktree open failure falls back to a plain workspace create", async () => {
    const calls: Call[] = [];
    const runner = {
      exec: async (argv: readonly string[]) => {
        calls.push({ argv: [...argv] });
        if (argv[2] === "open") return { stdout: "", stderr: "boom", exitCode: 1 };
        if (argv[2] === "create") return { stdout: WORKSPACE_CREATED, stderr: "", exitCode: 0 };
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    };
    const result = await createChildWorkspace(runner, {
      workDir: worktreeDir,
      label: "child",
      parentWorkspaceId: "wP",
    });
    expect(result).toEqual({ ok: true, paneId: "w9:p1", workspaceId: "w9" });
    // Nesting failed → the provenance token preserves the visible link.
    expect(calls.map((call) => call.argv[2])).toEqual(["open", "create", "get", "report-metadata"]);
  });

  test("same-checkout child + parent → plain create, then a parent provenance token", async () => {
    const fake = recorder();
    const result = await createChildWorkspace(fake.runner, {
      workDir: plainDir,
      label: "child",
      parentWorkspaceId: "wP",
    });
    expect(result).toEqual({ ok: true, paneId: "w9:p1", workspaceId: "w9" });
    expect(fake.calls.map((call) => call.argv[2])).toEqual(["create", "get", "report-metadata"]);
    const metadata = fake.calls[2].argv;
    expect(metadata.slice(0, 3)).toEqual(["herdr", "workspace", "report-metadata"]);
    expect(metadata[3]).toBe("w9");
    expect(metadata).toContain("--source");
    expect(metadata[metadata.indexOf("--source") + 1]).toBe("swarm-dao");
    // Human-readable parent label (from workspace get), not the opaque id.
    expect(metadata[metadata.indexOf("--token") + 1]).toBe("parent=parent-label");
  });

  test("token report failure never fails the creation", async () => {
    const runner = {
      exec: async (argv: readonly string[]) => {
        if (argv[2] === "create") return { stdout: WORKSPACE_CREATED, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "boom", exitCode: 1 };
      },
    };
    const result = await createChildWorkspace(runner, {
      workDir: plainDir,
      label: "child",
      parentWorkspaceId: "wP",
    });
    expect(result).toEqual({ ok: true, paneId: "w9:p1", workspaceId: "w9" });
  });

  test("no parent → plain create only", async () => {
    const fake = recorder();
    const result = await createChildWorkspace(fake.runner, { workDir: plainDir, label: "child" });
    expect(result).toEqual({ ok: true, paneId: "w9:p1", workspaceId: "w9" });
    expect(fake.calls.map((call) => call.argv[2])).toEqual(["create"]);
  });

  test("create failure carries the herdr detail", async () => {
    const runner = {
      exec: async () => ({
        stdout: "",
        stderr: JSON.stringify({ error: { code: "x", message: "down" } }),
        exitCode: 1,
      }),
    };
    const result = await createChildWorkspace(runner, { workDir: plainDir, label: "child" });
    expect(result).toEqual({ ok: false, error: "herdr workspace create failed: x: down" });
  });
});
