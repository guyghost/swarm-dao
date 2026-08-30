import { describe, expect, test } from "bun:test";
import type { AgentOutput, DAOAgent, Proposal } from "@guyghost/swarm-dao-core";
import { buildPriorAnalysesSection, dispatchSequentialSwarm, extractAnalysis } from "../src/intelligence/sequential.js";
import { createDispatchModelContext } from "../src/intelligence/swarm.js";
import type { AgentWorkerPort } from "../src/ports/host.js";
import { createInitialState } from "../src/types/index.js";

const AGENT_CONTENT =
  "## Analysis\nThe caching layer needs invalidation keys.\n\n## Vote\nfor\n\n## Reasoning\nLow risk.";

describe("extractAnalysis", () => {
  test("keeps everything before the vote section and drops vote/reasoning", () => {
    expect(extractAnalysis(AGENT_CONTENT)).toBe("## Analysis\nThe caching layer needs invalidation keys.");
  });

  test("returns the full content when no vote section exists", () => {
    expect(extractAnalysis("just analysis text")).toBe("just analysis text");
  });

  test("handles empty content", () => {
    expect(extractAnalysis("")).toBe("");
  });
});

describe("buildPriorAnalysesSection", () => {
  const output = (agentId: string, name: string, content: string): AgentOutput => ({
    agentId,
    agentName: name,
    role: "analyst",
    content,
    durationMs: 1,
  });

  test("returns an empty string when there is no prior output", () => {
    expect(buildPriorAnalysesSection([])).toBe("");
  });

  test("lists prior agents with their analysis only (no votes)", () => {
    const section = buildPriorAnalysesSection([output("strategist", "Strategist", AGENT_CONTENT)]);
    expect(section).toContain("## Prior Analyses");
    expect(section).toContain("Strategist");
    expect(section).toContain("The caching layer needs invalidation keys.");
    expect(section).not.toContain("## Vote");
    expect(section).not.toContain("## Reasoning");
  });

  test("caps each analysis at the configured length with an ellipsis", () => {
    const long = `## Analysis\n${"x".repeat(500)}`;
    const section = buildPriorAnalysesSection([output("a", "Agent A", long)], { charsPerAgent: 50 });
    // The cap applies to the whole analysis (heading included): the x-run
    // is truncated well below 500 and an ellipsis marks the cut.
    const xRun = section.match(/x+/)?.[0] ?? "";
    expect(xRun.length).toBeGreaterThan(0);
    expect(xRun.length).toBeLessThanOrEqual(50);
    expect(section).toContain("…");
    expect(section).not.toContain("x".repeat(100));
  });

  test("skips outputs with empty content (spawn failures)", () => {
    const failed: AgentOutput = {
      agentId: "broken",
      agentName: "Broken",
      role: "r",
      content: "",
      durationMs: 0,
      error: "spawn failed",
    };
    const section = buildPriorAnalysesSection([failed, output("ok", "OK", "## Analysis\nfine")]);
    expect(section).toContain("OK");
    expect(section).not.toContain("Broken");
  });
});

describe("dispatchSequentialSwarm", () => {
  function agent(id: string, name: string): DAOAgent {
    return {
      id,
      name,
      role: "analyst",
      description: "d",
      weight: 1,
      systemPrompt: `You are ${name}.`,
    };
  }

  function proposal(): Proposal {
    return {
      id: 1,
      title: "Sequential Test",
      type: "product-feature",
      description: "d",
      proposedBy: "t",
      status: "deliberating",
      votes: [],
      agentOutputs: [],
      ...createInitialState("/tmp/.dao"),
    } as unknown as Proposal;
  }

  /** Records (agentId, prompt) pairs and replies with a deterministic output. */
  function recordingWorker(calls: Array<{ agentId: string; prompt: string }>): AgentWorkerPort {
    return {
      spawnAgent: async ({ agent, systemPrompt }) => {
        calls.push({ agentId: agent.id, prompt: systemPrompt });
        return {
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          content: `## Analysis\nAnalysis by ${agent.id} — unique-${agent.id}.\n\n## Vote\nfor\n\n## Reasoning\nr`,
          durationMs: 1,
        };
      },
    };
  }

  test("spawns agents in order and feeds prior analyses (never votes) forward", async () => {
    const calls: Array<{ agentId: string; prompt: string }> = [];
    const outputs = await dispatchSequentialSwarm(
      proposal(),
      [agent("first", "First"), agent("second", "Second")],
      recordingWorker(calls),
      createDispatchModelContext("test-model", recordingWorker([])),
    );

    expect(calls.map((call) => call.agentId)).toEqual(["first", "second"]);
    expect(outputs).toHaveLength(2);

    // The first agent sees no prior section.
    expect(calls[0]?.prompt).not.toContain("## Prior Analyses");
    // The second agent sees the first agent's analysis…
    expect(calls[1]?.prompt).toContain("## Prior Analyses");
    expect(calls[1]?.prompt).toContain("unique-first");
    // …but never the first agent's vote or reasoning.
    expect(calls[1]?.prompt).not.toContain("## Vote\nfor");
    expect(calls[1]?.prompt).not.toContain("## Reasoning");
  });

  test("a failed spawn records an error output and later agents still run", async () => {
    const calls: Array<{ agentId: string; prompt: string }> = [];
    const worker: AgentWorkerPort = {
      spawnAgent: async ({ agent, systemPrompt }) => {
        calls.push({ agentId: agent.id, prompt: systemPrompt });
        if (agent.id === "boom") throw new Error("spawn failed");
        return {
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          content: `## Analysis\nAnalysis by ${agent.id}.\n\n## Vote\nfor\n\n## Reasoning\nr`,
          durationMs: 1,
        };
      },
    };

    const outputs = await dispatchSequentialSwarm(
      proposal(),
      [agent("boom", "Boom"), agent("after", "After")],
      worker,
      createDispatchModelContext("test-model", worker),
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.error).toBe("spawn failed");
    expect(outputs[1]?.error).toBeUndefined();
    // The surviving agent runs, without the failed agent's (empty) content.
    expect(calls[1]?.prompt).not.toContain("Boom");
  });
});
