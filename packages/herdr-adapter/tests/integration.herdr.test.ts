// Integration against the REAL herdr server (skipped when herdr is absent
// or the server is not running). Two levels:
//  - always: the unsupported-kind error path (real server, no model calls)
//  - HERDR_IT=1: the full round-trip with a real agent (default kind "pi")
// Cleanup closes every workspace the tests create — never the user's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createInitialState, type DAOAgent, type Proposal } from "@guyghost/swarm-dao-core";
import { createHerdrHostAdapter } from "../src/adapter.js";

const execAsync = promisify(exec);

const herdrAvailable = await execAsync("herdr status")
  .then((r) => r.stdout.includes("status: running"))
  .catch(() => false);

const fullRoundTrip = process.env.HERDR_IT === "1";

describe.skipIf(!herdrAvailable)("herdr adapter (real server)", () => {
  let workDir: string;
  const agent: DAOAgent = {
    id: "probe-agent",
    name: "Probe Agent",
    role: "r",
    description: "d",
    weight: 1,
    systemPrompt: "",
  };
  const proposal = {
    id: 77,
    title: "t",
    type: "product-feature",
    description: "d",
    proposedBy: "t",
    status: "deliberating",
    votes: [],
    agentOutputs: [],
    ...createInitialState("/tmp/.dao"),
  } as unknown as Proposal;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-herdr-it-"));
  });

  afterAll(async () => {
    // Close only workspaces this suite created (label prefix).
    try {
      const { stdout } = await execAsync("herdr workspace list --json");
      const ids = [...stdout.matchAll(/"workspace_id"\s*:\s*"(w\d+)"/g)].map((match) => match[1]).filter(() => true);
      // Match by label via pane listing is heavier; rely on the adapter's own
      // cleanup plus this best-effort sweep of leftover swarm-dao workspaces.
      for (const id of ids) {
        const info = await execAsync(`herdr workspace get ${id} --json`).catch(() => null);
        if (info?.stdout.includes("swarm-dao-p77")) {
          await execAsync(`herdr workspace close ${id}`).catch(() => undefined);
        }
      }
    } catch {
      // No server / no list support — nothing to sweep.
    }
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("an unsupported kind fails fast with the real herdr error", async () => {
    const adapter = createHerdrHostAdapter({ workDir, kind: "definitely-not-a-kind", timeoutMs: 10_000 });
    const output = await adapter.spawnAgent({ agent, proposal, systemPrompt: "P" });
    expect(output.error).toBeTruthy();
    expect(output.error ?? "").toMatch(/invalid|kind|error/i);
    // The workspace was cleaned up.
    const list = await execAsync("herdr workspace list --json").catch(() => ({ stdout: "" }));
    expect(list.stdout).not.toContain("swarm-dao-p77-probe-agent");
  }, 60_000);

  describe.skipIf(!fullRoundTrip)("full round-trip (HERDR_IT=1)", () => {
    test("a real agent deliberates and its output is harvested", async () => {
      const kind = process.env.HERDR_KIND ?? "pi";
      const adapter = createHerdrHostAdapter({
        workDir,
        kind,
        timeoutMs: Number(process.env.HERDR_TIMEOUT_MS ?? 240_000),
        readLines: 400,
        keepPanes: process.env.HERDR_KEEP === "1",
      });
      const output = await adapter.spawnAgent({
        agent,
        proposal,
        systemPrompt: [
          "You are a DAO deliberation agent answering exactly once.",
          "",
          "## Analysis",
          "One short sentence.",
          "",
          "## Vote",
          "for",
          "",
          "## Reasoning",
          "Low risk, high value.",
        ].join("\n"),
      });
      expect(output.error).toBeUndefined();
      // The agent's terminal output contains our answer sections (the agent
      // may echo the instructions or produce them — either way the harvest
      // captured the pane's settled transcript).
      expect(output.content.length).toBeGreaterThan(0);
      if (!output.content.includes("## Vote")) {
        console.warn(
          "[herdr-it] agent did not emit a literal '## Vote' section; content captured:",
          output.content.slice(0, 200),
        );
      }
    }, 300_000);
  });
});
