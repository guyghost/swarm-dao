import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetAgentDefinitionCache,
  DEFAULT_AGENT_MODEL,
  initializeAgents,
  loadAgentDefinitionsFromMarkdown,
} from "../src/governance/agents.js";

describe("governance/agents.ts", () => {
  beforeEach(() => {
    __resetAgentDefinitionCache();
  });

  it("initializes agents with the default model", () => {
    const agents = initializeAgents();
    expect(agents.length).toBe(7);
    expect(agents.every((agent) => agent.model === DEFAULT_AGENT_MODEL)).toBe(true);
  });

  it("loads model overrides from markdown frontmatter", async () => {
    const agentsDir = path.join(tmpdir(), `swarm-agents-${Date.now()}`);
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "dao-architect.md"),
      `---
id: architect
name: Solution Architect
model: custom/architect-model
weight: 3
---
`,
      "utf-8",
    );

    const agents = await loadAgentDefinitionsFromMarkdown(agentsDir);
    const architect = agents.find((agent) => agent.id === "architect");
    expect(architect?.model).toBe("custom/architect-model");
  });

  it("caches agent definitions across calls and invalidates on file change", async () => {
    const agentsDir = path.join(tmpdir(), `swarm-agents-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(agentsDir, { recursive: true });
    const agentFile = path.join(agentsDir, "dao-foo.md");
    await fs.writeFile(
      agentFile,
      `---
id: architect
name: Solution Architect
model: custom/architect-model-v1
weight: 3
---
`,
      "utf-8",
    );

    const readFileSpy = spyOn(fs, "readFile");
    try {
      // First call: cache miss -> reads the dao-*.md file from disk.
      const first = await loadAgentDefinitionsFromMarkdown(agentsDir);
      expect(first.find((agent) => agent.id === "architect")?.model).toBe("custom/architect-model-v1");
      const readsAfterFirst = readFileSpy.mock.calls.length;
      expect(readsAfterFirst).toBeGreaterThan(0);

      // Second call: signature unchanged -> cache hit -> zero files re-read.
      const second = await loadAgentDefinitionsFromMarkdown(agentsDir);
      expect(second.find((agent) => agent.id === "architect")?.model).toBe("custom/architect-model-v1");
      expect(readFileSpy.mock.calls.length).toBe(readsAfterFirst);

      // Modify the file (content + size + mtime change) -> signature changes.
      await fs.writeFile(
        agentFile,
        `---
id: architect
name: Solution Architect
model: custom/architect-model-v2-updated
weight: 3
---
`,
        "utf-8",
      );

      // Third call: signature changed -> cache miss -> re-reads from disk.
      const third = await loadAgentDefinitionsFromMarkdown(agentsDir);
      expect(third.find((agent) => agent.id === "architect")?.model).toBe("custom/architect-model-v2-updated");
      expect(readFileSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("does not reuse cached markdown merge across different base agents", async () => {
    const agentsDir = path.join(tmpdir(), `swarm-agents-base-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(agentsDir, { recursive: true });

    const baseAgentsA = initializeAgents();
    const baseAgentsB = baseAgentsA.map((agent) =>
      agent.id === "architect" ? { ...agent, name: "Architect Override From Base B" } : agent,
    );

    const fromBaseA = await loadAgentDefinitionsFromMarkdown(agentsDir, baseAgentsA);
    const fromBaseB = await loadAgentDefinitionsFromMarkdown(agentsDir, baseAgentsB);

    expect(fromBaseA.find((agent) => agent.id === "architect")?.name).toBe("Solution Architect");
    expect(fromBaseB.find((agent) => agent.id === "architect")?.name).toBe("Architect Override From Base B");
  });
});
