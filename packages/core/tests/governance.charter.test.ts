import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetAgentDefinitionCache,
  getDefaultAgentPrompts,
  initializeAgents,
  loadAgentDefinitionsFromMarkdown,
} from "../src/governance/agents.js";
import { AGENT_CHARTER, composeSystemPrompt } from "../src/governance/charter.js";

describe("charter composition", () => {
  test("the charter carries the binding law and the parseable output format", () => {
    expect(AGENT_CHARTER).toContain("## Analysis");
    expect(AGENT_CHARTER).toContain("## Vote");
    expect(AGENT_CHARTER).toContain("for | against | abstain");
    expect(AGENT_CHARTER).toContain("## Composite Score Inputs (0-10)");
    expect(AGENT_CHARTER).toContain("## Risk Score (1-10)");
  });

  test("compose layers: shared charter first, then role, then project layers", () => {
    const prompt = composeSystemPrompt("ROLE TEXT", {
      projectCharter: "PROJECT CHARTER",
      agentOverride: "AGENT OVERRIDE",
    });
    const charterIndex = prompt.indexOf("AGENT_CHARTER_MARKER");
    expect(prompt.indexOf(AGENT_CHARTER)).toBeLessThan(prompt.indexOf("ROLE TEXT"));
    expect(prompt.indexOf("ROLE TEXT")).toBeLessThan(prompt.indexOf("## Project Charter Addendum"));
    expect(prompt.indexOf("## Project Charter Addendum")).toBeLessThan(prompt.indexOf("## Project Instructions"));
    expect(prompt).toContain("PROJECT CHARTER");
    expect(prompt).toContain("AGENT OVERRIDE");
    expect(charterIndex).toBe(-1); // sanity: no marker noise
  });

  test("compose without layers is charter + role only", () => {
    const prompt = composeSystemPrompt("ROLE TEXT");
    expect(prompt.startsWith(AGENT_CHARTER)).toBe(true);
    expect(prompt.endsWith("ROLE TEXT")).toBe(true);
    expect(prompt).not.toContain("## Project");
  });
});

describe("layered default agents", () => {
  test("initializeAgents composes the charter into every default prompt", () => {
    const agents = initializeAgents();
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.systemPrompt.startsWith(AGENT_CHARTER)).toBe(true);
      expect(agent.systemPrompt).toContain("Your mission");
    }
    // The role layer keeps its identity: no duplicated output-format block.
    const strategist = agents.find((agent) => agent.id === "strategist");
    expect(strategist?.systemPrompt).toContain("Product Strategist");
    expect(strategist?.systemPrompt.match(/## Vote/g)?.length).toBe(1);
  });

  test("getDefaultAgentPrompts returns composed prompts", () => {
    const prompts = getDefaultAgentPrompts();
    for (const prompt of Object.values(prompts)) {
      expect(prompt.startsWith(AGENT_CHARTER)).toBe(true);
    }
  });

  test("custom agents pass through initializeAgents untouched", () => {
    const custom = [{ ...initializeAgents()[0]!, id: "custom", systemPrompt: "RAW" }];
    expect(initializeAgents(custom)[0]?.systemPrompt).toBe("RAW");
  });
});

describe("markdown layers (charter.md + dao-*.md bodies)", () => {
  let agentsDir: string;

  beforeAll(async () => {
    agentsDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-charter-"));
    await fs.writeFile(
      path.join(agentsDir, "charter.md"),
      "# Project Charter\n\nThis project values shipping small reversible changes.\n",
    );
    await fs.writeFile(
      path.join(agentsDir, "dao-strategist.md"),
      `---\nid: strategist\nweight: 5\n---\n\nAlways weigh maintenance burden explicitly.\n`,
    );
    __resetAgentDefinitionCache();
  });

  afterAll(async () => {
    await fs.rm(agentsDir, { recursive: true, force: true });
    __resetAgentDefinitionCache();
  });

  test("frontmatter still overrides fields; the body replaces the role prompt; charter.md applies to all", async () => {
    const agents = await loadAgentDefinitionsFromMarkdown(agentsDir);
    const strategist = agents.find((agent) => agent.id === "strategist");
    expect(strategist?.weight).toBe(5);

    // Order: shared charter (never replaceable), then the markdown body as
    // the role definition, then the project charter addendum.
    const prompt = strategist?.systemPrompt ?? "";
    expect(prompt.startsWith(AGENT_CHARTER)).toBe(true);
    expect(prompt.indexOf("## Project Charter Addendum")).toBeGreaterThan(prompt.indexOf(AGENT_CHARTER));
    expect(prompt).toContain("shipping small reversible changes");
    // The body REPLACES the default role prompt (frontmatter-consistent
    // override semantics), so the default mission text is gone.
    expect(prompt).toContain("Always weigh maintenance burden explicitly");
    expect(prompt).not.toContain("Your mission: evaluate proposals from a product strategy perspective");

    // The project charter applies to every agent.
    const critic = agents.find((agent) => agent.id === "critic");
    expect(critic?.systemPrompt).toContain("shipping small reversible changes");
  });

  test("a directory without markdown files behaves exactly as before", async () => {
    const empty = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-empty-"));
    try {
      __resetAgentDefinitionCache();
      const agents = await loadAgentDefinitionsFromMarkdown(empty);
      expect(agents[0]?.systemPrompt.startsWith(AGENT_CHARTER)).toBe(true);
      expect(agents[0]?.systemPrompt).not.toContain("## Project");
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
