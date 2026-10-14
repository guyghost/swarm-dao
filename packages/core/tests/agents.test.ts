import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetAgentDefinitionCache,
  DEFAULT_AGENTS,
  formatAgentCard,
  formatAgentsTable,
  getDefaultAgentPrompts,
  initializeAgents,
  loadAgentDefinitions,
  loadAgentDefinitionsFromMarkdown,
} from "../src/governance/agents.js";

describe("governance/agents.ts", () => {
  beforeEach(() => {
    __resetAgentDefinitionCache();
  });

  it("initializes agents without a hardcoded model", () => {
    const agents = initializeAgents();
    expect(agents.length).toBe(8);
    // No per-agent model: resolution happens at dispatch time (config default,
    // then parent session / host default).
    expect(agents.every((agent) => agent.model === undefined)).toBe(true);
    // The designer is part of the default swarm and declares its tooling.
    const designer = agents.find((agent) => agent.id === "designer");
    expect(designer?.tools).toEqual(["impeccable", "mobbin"]);
    expect(agents.find((agent) => agent.id === "architect")?.tools).toEqual(["sequential-thinking"]);
  });

  it("parses tools from markdown frontmatter", async () => {
    const agentsDir = path.join(tmpdir(), `swarm-agents-tools-${Date.now()}`);
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "dao-designer.md"),
      `---\nid: designer\nname: UX/UI Designer\nweight: 2\ntools: [impeccable, mobbin]\n---\n\n# Designer body`,
    );

    const agents = await loadAgentDefinitionsFromMarkdown(agentsDir);
    const designer = agents.find((agent) => agent.id === "designer");
    expect(designer?.tools).toEqual(["impeccable", "mobbin"]);
    expect(designer?.systemPrompt).toContain("# Designer body");
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

  it("loads multiple markdown agent files and charter.md concurrently", async () => {
    const agentsDir = path.join(tmpdir(), `swarm-agents-parallel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(agentsDir, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(agentsDir, "dao-architect.md"),
        "---\nid: architect\nname: Custom Architect\nweight: 4\n---\n\nArchitect custom prompt.",
        "utf-8",
      ),
      fs.writeFile(
        path.join(agentsDir, "dao-critic.md"),
        "---\nid: critic\nname: Custom Critic\nweight: 5\n---\n\nCritic custom prompt.",
        "utf-8",
      ),
      fs.writeFile(path.join(agentsDir, "charter.md"), "Project-level custom charter rule.", "utf-8"),
    ]);

    try {
      const agents = await loadAgentDefinitionsFromMarkdown(agentsDir);
      const architect = agents.find((a) => a.id === "architect");
      const critic = agents.find((a) => a.id === "critic");
      expect(architect?.name).toBe("Custom Architect");
      expect(architect?.weight).toBe(4);
      expect(architect?.systemPrompt).toContain("Architect custom prompt.");
      expect(architect?.systemPrompt).toContain("Project-level custom charter rule.");
      expect(critic?.name).toBe("Custom Critic");
      expect(critic?.weight).toBe(5);
      expect(critic?.systemPrompt).toContain("Critic custom prompt.");
      expect(critic?.systemPrompt).toContain("Project-level custom charter rule.");
    } finally {
      await fs.rm(agentsDir, { recursive: true, force: true });
    }
  });

  it("loadAgentDefinitions resolves closest candidate agents dir and applies projectConfig filters", async () => {
    const daoRoot = path.join(tmpdir(), `swarm-load-defs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const agentsDir = path.join(daoRoot, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "dao-strategist.md"),
      "---\nid: strategist\nname: Lead Strategist\nweight: 5\n---\n\nCustom strategist prompt.",
      "utf-8",
    );

    try {
      const filtered = await loadAgentDefinitions(daoRoot, {
        mode: "opt-in",
        agentOverrides: { researcher: { enabled: false } },
      });
      expect(filtered.find((a) => a.id === "strategist")?.name).toBe("Lead Strategist");
      expect(filtered.find((a) => a.id === "researcher")).toBeUndefined();
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("formats agent tables, cards, and default prompts", () => {
    const agents = initializeAgents();
    const table = formatAgentsTable(agents);
    expect(table).toContain("| Product Strategist | 3 |");

    const firstAgent = DEFAULT_AGENTS[0];
    expect(firstAgent).toBeDefined();
    if (!firstAgent) return;
    const card = formatAgentCard(firstAgent);
    expect(card).toContain("## Product Strategist (`strategist`)");
    expect(card).toContain("**Weight:** 3");

    const prompts = getDefaultAgentPrompts();
    expect(Object.keys(prompts)).toContain("strategist");
    expect(prompts.strategist).toContain("You are the Product Strategist.");
  });
});
