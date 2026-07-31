import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createClaudeHostAdapter } from "@guyghost/swarm-dao-claude-adapter";
import { createCodexHostAdapter } from "@guyghost/swarm-dao-codex-adapter";
import { createCopilotHostAdapter } from "@guyghost/swarm-dao-copilot-adapter";
import { type DaoCommandHost, getDaoCommands, type HostAdapter } from "@guyghost/swarm-dao-core";
import { createMcpHostAdapter } from "@guyghost/swarm-dao-mcp";
import { createWorkspace } from "../support/fixtures.js";

const HOST_ADAPTERS: ReadonlyArray<{ host: DaoCommandHost; create: (workDir: string) => HostAdapter }> = [
  { host: "mcp", create: createMcpHostAdapter },
  { host: "claude", create: createClaudeHostAdapter },
  { host: "codex", create: createCodexHostAdapter },
  { host: "copilot", create: createCopilotHostAdapter },
];

describe("Compatibility: stdio host adapters implement the same contract", () => {
  for (const { host, create } of HOST_ADAPTERS) {
    it(`${host} exposes the full HostAdapter surface`, async () => {
      const workspace = await createWorkspace(`compat-${host}`);
      try {
        const adapter = create(workspace.dir);

        expect(adapter.hostId).toBe(host);
        expect(adapter.getWorkingDirectory()).toBe(workspace.dir);
        for (const method of ["spawnAgent", "spawnAgents", "log", "readFile", "writeFile", "exec", "hasCapability"]) {
          expect(typeof adapter[method as keyof HostAdapter]).toBe("function");
        }
        for (const capability of ["read_file", "write_file", "exec", "log"]) {
          expect(adapter.hasCapability(capability)).toBe(true);
        }
        expect(adapter.hasCapability("teleportation")).toBe(false);
      } finally {
        await workspace.cleanup();
      }
    });

    it(`${host} sandboxes file access to its working directory`, async () => {
      const workspace = await createWorkspace(`compat-fs-${host}`);
      try {
        const adapter = create(workspace.dir);

        await adapter.writeFile("notes.md", "inside");
        expect(await adapter.readFile("notes.md")).toBe("inside");
        expect(await fs.readFile(path.join(workspace.dir, "notes.md"), "utf8")).toBe("inside");

        await expect(adapter.readFile("../escape.md")).rejects.toThrow("Path traversal denied");
        await expect(adapter.writeFile("../escape.md", "outside")).rejects.toThrow("Path traversal denied");
      } finally {
        await workspace.cleanup();
      }
    });

    it(`${host} routes deliberation to the manual record-outputs flow`, async () => {
      const workspace = await createWorkspace(`compat-agents-${host}`);
      try {
        const adapter = create(workspace.dir);
        const agent = {
          id: "architect",
          name: "Architect",
          role: "Architecture",
          description: "d",
          systemPrompt: "sp",
          weight: 3,
        };
        const proposal = {
          id: 1,
          title: "t",
          type: "product-feature" as const,
          description: "d",
          proposedBy: "user",
          status: "open" as const,
          votes: [],
          agentOutputs: [],
          createdAt: new Date().toISOString(),
        };

        const output = await adapter.spawnAgent({ agent, proposal, systemPrompt: "sp" });
        expect(output.content).toBe("");
        expect(output.error).toContain("dao_record_outputs");
        expect(await adapter.spawnAgents({ agents: [agent], proposal, maxConcurrent: 4 })).toEqual([]);
      } finally {
        await workspace.cleanup();
      }
    });

    it(`${host} rejects unsafe shell commands`, async () => {
      const workspace = await createWorkspace(`compat-exec-${host}`);
      try {
        const adapter = create(workspace.dir);
        const unsafe = await adapter.exec("echo ok; rm -rf /");
        expect(unsafe.exitCode).toBe(1);
        expect(unsafe.stderr).toContain("Unsafe command");
      } finally {
        await workspace.cleanup();
      }
    });
  }

  it("gives every host the registry lifecycle spine", () => {
    for (const { host } of HOST_ADAPTERS) {
      const ids = getDaoCommands(host).map((command) => command.id);
      expect(ids).toEqual(expect.arrayContaining(["setup", "propose", "deliberate", "control", "execute"]));
    }
  });
});
