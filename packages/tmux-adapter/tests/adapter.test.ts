// Unit tests for the tmux host adapter: session-program construction,
// sanitization, capture-pane harvest, fail-fast, timeouts, and containment —
// with a fake tmux runner over a real temporary working directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DAOAgent, Proposal } from "@guyghost/swarm-dao-core";
import { createInitialState } from "@guyghost/swarm-dao-core";
import { createTmuxHostAdapter, sanitizeSessionName } from "../src/adapter.js";

type Call = { command: string; options?: { cwd?: string } };

function fakeTmux() {
  const calls: Call[] = [] as Call[];
  let paneContent = "";
  let exitCode = "0";
  let newSessionFails = false;
  const api = {
    calls,
    /** What the pane will hold (returned by capture-pane) and its exit code. */
    pane(content: string, code = "0") {
      paneContent = content;
      exitCode = code;
    },
    failNewSession(message: string) {
      newSessionFails = true;
      api.paneError = message;
    },
    paneError: "",
    runner: {
      exec: async (command: string, options?: { cwd?: string }) => {
        calls.push({ command, options });
        if (command.includes("capture-pane")) {
          return { stdout: paneContent, stderr: "", exitCode: 0 };
        }
        if (command.includes("tmux new-session") && newSessionFails) {
          return { stdout: "", stderr: api.paneError, exitCode: 1 };
        }
        if (command.includes("tmux new-session")) {
          // The pane writes its done marker when the session program runs.
          const runDir = command.match(/([^\s'"]*\.dao\/tmux\/\d+\/[A-Za-z0-9_-]+)/)?.[1];
          if (runDir) {
            await fs.mkdir(runDir, { recursive: true });
            await fs.writeFile(path.join(runDir, "done"), exitCode);
          }
        }
        return { stdout: "", stderr: "", exitCode: 0 };
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
    title: "Tmux Feature",
    type: "product-feature",
    description: "d",
    proposedBy: "t",
    status: "deliberating",
    votes: [],
    agentOutputs: [],
    ...createInitialState("/tmp/.dao"),
  } as unknown as Proposal;
}

describe("tmux host adapter", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-tmux-unit-"));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("streams the agent command into the pane program and harvests via capture-pane", async () => {
    const fake = fakeTmux();
    fake.pane("## Analysis\nok\n## Vote\nfor\n## Reasoning\nr");
    const adapter = createTmuxHostAdapter({ workDir, runner: fake.runner, command: "agent-cli" });

    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(1),
      systemPrompt: "PROMPT-critic",
    });

    const newSession = fake.calls.find((c) => c.command.includes("tmux new-session"));
    const capture = fake.calls.find((c) => c.command.includes("capture-pane"));
    const kill = fake.calls.filter((c) => c.command.includes("tmux kill-session"));
    expect(newSession?.command).toContain("swarm-dao-p1-critic");
    expect(newSession?.command).toContain("agent-cli");
    expect(newSession?.command).toContain("PROMPT=");
    expect(newSession?.command).not.toContain("> output.md"); // output streams to the pane
    // Stale-name purge before creation, then cleanup after harvest.
    const newSessionIndex = fake.calls.findIndex((c) => c.command.includes("tmux new-session"));
    expect(kill.length).toBe(2);
    const firstKill = kill[0] ?? { command: "" };
    const secondKill = kill[1] ?? { command: "" };
    expect(fake.calls.indexOf(firstKill)).toBeLessThan(newSessionIndex);
    expect(fake.calls.indexOf(secondKill)).toBeGreaterThan(fake.calls.indexOf(capture ?? { command: "" }));

    const prompt = await fs.readFile(path.join(workDir, ".dao/tmux/1/critic/prompt.md"), "utf8");
    expect(prompt).toBe("PROMPT-critic");

    expect(output.agentId).toBe("critic");
    expect(output.error).toBeUndefined();
    expect(output.content).toContain("## Vote");
  });

  test("hostile agent ids cannot traverse out of the run directory", async () => {
    const fake = fakeTmux();
    fake.pane("## Analysis\na\n## Vote\nfor\n## Reasoning\nr");
    const adapter = createTmuxHostAdapter({ workDir, runner: fake.runner, command: "agent-cli" });

    await adapter.spawnAgent({
      agent: agent("../../etc-passwd"),
      proposal: proposal(8),
      systemPrompt: "P",
    });
    const newSession = fake.calls.find((c) => c.command.includes("tmux new-session"));
    expect(newSession?.command).toContain("swarm-dao-p8-etc-passwd");
    // The run directory uses the sanitized segment — no traversal.
    expect(newSession?.command).toContain(".dao/tmux/8/etc-passwd");
    expect(newSession?.command).not.toContain("../");
    const marker = path.join(workDir, ".dao/tmux/8/etc-passwd/done");
    expect(await fs.readFile(marker, "utf8")).toBe("0");
  });

  test("a non-zero exit code surfaces as an error with the pane content kept", async () => {
    const fake = fakeTmux();
    fake.pane("partial output", "127");
    const adapter = createTmuxHostAdapter({ workDir, runner: fake.runner, command: "agent-cli" });

    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(2),
      systemPrompt: "P",
    });
    expect(output.error).toContain("127");
    expect(output.content).toContain("partial output");
  });

  test("a tmux new-session failure fails fast instead of timing out", async () => {
    const fake = fakeTmux();
    fake.failNewSession("no server running");
    const adapter = createTmuxHostAdapter({
      workDir,
      runner: fake.runner,
      command: "agent-cli",
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });

    const startedAt = Date.now();
    const output = await adapter.spawnAgent({
      agent: agent("critic"),
      proposal: proposal(3),
      systemPrompt: "P",
    });
    expect(output.error).toContain("tmux new-session failed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("a timeout kills the session and reports a deterministic error", async () => {
    // A fake that never writes the done marker: strip the simulate behavior.
    const calls: Call[] = [];
    const runner = {
      exec: async (command: string, options?: { cwd?: string }) => {
        calls.push({ command, options });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const adapter = createTmuxHostAdapter({
      workDir,
      runner,
      command: "agent-cli",
      timeoutMs: 150,
      pollIntervalMs: 50,
    });

    const output = await adapter.spawnAgent({
      agent: agent("slow"),
      proposal: proposal(4),
      systemPrompt: "P",
    });
    expect(output.error).toContain("timed out");
    expect(calls.some((c) => c.command.includes("tmux kill-session"))).toBe(true);
  });

  test("the per-call timeoutMs overrides the adapter default", async () => {
    const calls: Call[] = [];
    const runner = {
      exec: async (command: string, options?: { cwd?: string }) => {
        calls.push({ command, options });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const adapter = createTmuxHostAdapter({
      workDir,
      runner,
      command: "agent-cli",
      timeoutMs: 60_000,
      pollIntervalMs: 50,
    });
    const output = await adapter.spawnAgent({
      agent: agent("slow"),
      proposal: proposal(5),
      systemPrompt: "P",
      timeoutMs: 120,
    });
    expect(output.error).toContain("timed out after 120ms");
  });

  test("missing command configuration fails with a copy-pasteable setup message", async () => {
    const fake = fakeTmux();
    const adapter = createTmuxHostAdapter({ workDir, runner: fake.runner, command: "" });
    const output = await adapter.spawnAgent({ agent: agent("any"), proposal: proposal(6), systemPrompt: "P" });
    expect(output.error).toContain('your-agent-cli "$PROMPT"');
    expect(output.error).toContain(".dao/config.json");
  });

  test("keepSessions leaves the pane alive without an exit race", async () => {
    const fake = fakeTmux();
    fake.pane("## Analysis\na\n## Vote\nfor\n## Reasoning\nr");
    const adapter = createTmuxHostAdapter({
      workDir,
      runner: fake.runner,
      command: "agent-cli",
      keepSessions: true,
    });

    await adapter.spawnAgent({ agent: agent("critic"), proposal: proposal(7), systemPrompt: "P" });
    const kills = fake.calls.filter((c) => c.command.includes("tmux kill-session"));
    const newSessionIndex = fake.calls.findIndex((c) => c.command.includes("tmux new-session"));
    // Only the pre-creation purge: the pane idles so the operator can inspect
    // its scrollback after harvest.
    expect(kills).toHaveLength(1);
    expect(fake.calls.indexOf(kills[0] ?? { command: "" })).toBeLessThan(newSessionIndex);
    expect(fake.calls[newSessionIndex]?.command).toContain("while :");
  });

  test("readFile/writeFile are contained under workDir", async () => {
    const fake = fakeTmux();
    const adapter = createTmuxHostAdapter({ workDir, runner: fake.runner, command: "x" });
    await fs.mkdir(path.join(workDir, "notes"), { recursive: true });
    await adapter.writeFile("notes/inner.txt", "ok");
    expect(await adapter.readFile("notes/inner.txt")).toBe("ok");
    // Absolute escape and traversal are refused.
    await expect(adapter.writeFile("../outside.txt", "x")).rejects.toThrow("escapes");
    await expect(adapter.readFile("/etc/passwd")).rejects.toThrow("escapes");
  });

  test("spawnAgents fans out one session per agent", async () => {
    const fake = fakeTmux();
    fake.pane("## Analysis\na\n## Vote\nfor\n## Reasoning\nr");
    const adapter = createTmuxHostAdapter({ workDir, runner: fake.runner, command: "agent-cli" });

    const outputs = await adapter.spawnAgents({
      agents: [agent("a"), agent("b"), agent("c")],
      proposal: proposal(9),
      maxConcurrent: 3,
    });
    expect(outputs).toHaveLength(3);
    const sessions = fake.calls.filter((c) => c.command.includes("tmux new-session"));
    expect(sessions.length).toBe(3);
    const names = sessions.map((s) => s.command.match(/-s (\S+?)(?: -c)/)?.[1]);
    expect(new Set(names).size).toBe(3);
  });

  test("session names sanitize unsafe characters", () => {
    expect(sanitizeSessionName("critic/risk agent")).toBe("critic-risk-agent");
    expect(sanitizeSessionName("a`b$c;d")).toBe("a-b-c-d");
    expect(sanitizeSessionName("")).toBe("agent");
  });
});
