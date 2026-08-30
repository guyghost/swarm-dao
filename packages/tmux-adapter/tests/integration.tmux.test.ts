// Integration: the real tmux binary, real detached panes, a scripted
// "agent", real completion markers, and pane-streamed output harvested via
// capture-pane. Skipped entirely when tmux is not installed. Cleanup kills
// ONLY this adapter's sessions (never the developer's whole tmux server).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createInitialState, type DAOAgent, type Proposal } from "@guyghost/swarm-dao-core";
import { createTmuxHostAdapter } from "../src/adapter.js";

const execAsync = promisify(exec);
const hasTmux = await execAsync("tmux -V")
  .then(() => true)
  .catch(() => false);

/** Kill only the sessions this adapter created (prefix swarm-dao-). */
async function killAdapterSessions(): Promise<void> {
  try {
    const { stdout } = await execAsync("tmux list-sessions -F '#{session_name}'");
    const ours = stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.startsWith("swarm-dao-"));
    await Promise.all(ours.map((name) => execAsync(`tmux kill-session -t ${name}`).catch(() => undefined)));
  } catch {
    // No server / no sessions.
  }
}

describe.skipIf(!hasTmux)("tmux adapter (real tmux)", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-tmux-it-"));
  });

  afterAll(async () => {
    await killAdapterSessions();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const agent: DAOAgent = {
    id: "echo-agent",
    name: "Echo Agent",
    role: "r",
    description: "d",
    weight: 1,
    systemPrompt: "",
  };

  const proposal = {
    id: 42,
    title: "t",
    type: "product-feature",
    description: "d",
    proposedBy: "t",
    status: "deliberating",
    votes: [],
    agentOutputs: [],
    ...createInitialState(workDir),
  } as unknown as Proposal;

  test("a real pane streams the agent output and the harvest captures it", async () => {
    // The scripted agent: answer with a vote, echoing the $PROMPT variable.
    // (\n — printf renders the newlines; the command itself stays one line.)
    const command = `printf '## Analysis\\nprompt-was-%s\\n\\n## Vote\\nfor\\n\\n## Reasoning\\nr\\n' "$PROMPT"`;
    const adapter = createTmuxHostAdapter({ workDir, command, timeoutMs: 20_000, pollIntervalMs: 100 });

    const output = await adapter.spawnAgent({
      agent,
      proposal,
      systemPrompt: "UNIQUE-PROMPT-42",
    });

    expect(output.error).toBeUndefined();
    expect(output.content).toContain("## Vote");
    expect(output.content).toContain("for");
    // The pane received the actual prompt content.
    expect(output.content).toContain("prompt-was-UNIQUE-PROMPT-42");
    // The session is cleaned up.
    const sessions = await execAsync("tmux list-sessions").catch(() => ({ stdout: "" }));
    expect(sessions.stdout).not.toContain("swarm-dao-p42");
  }, 20_000);

  test("keepSessions leaves the pane alive for inspection", async () => {
    const command = `printf '## Analysis\\na\\n\\n## Vote\\nabstain\\n\\n## Reasoning\\nr\\n'`;
    const adapter = createTmuxHostAdapter({
      workDir,
      command,
      timeoutMs: 20_000,
      pollIntervalMs: 100,
      keepSessions: true,
    });

    const output = await adapter.spawnAgent({ agent, proposal, systemPrompt: "x" });
    expect(output.content).toContain("abstain");
    const sessions = await execAsync("tmux list-sessions").then(
      (r) => r.stdout,
      () => "",
    );
    expect(sessions).toContain("swarm-dao-p42-echo-agent");
  }, 20_000);
});
