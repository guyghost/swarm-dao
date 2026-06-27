import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_MODEL, initializeAgents, loadAgentDefinitionsFromMarkdown } from "../src/governance/agents.js";

describe("governance/agents.ts", () => {
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
});
