// ============================================================
// Swarm DAO Core — Sequential (pipeline) Deliberation
// ============================================================
// The swarm-forge pipeline pattern, adapted to DAO deliberation: agents
// deliberate in order, and each agent receives the ANALYSES of the agents
// before it — never their votes or reasoning, so the deterministic tally
// keeps its independence. Deeper deliberation without giving any agent (or
// any LLM) authority over the outcome: the tally still decides.
//
// Boundary (unchanged): this is orchestration only. No proposal states, no
// transitions, no new AI authority — agents still emit text that is parsed
// into votes exactly as in the parallel strategy.

import type { AgentWorkerPort } from "../ports/host.js";
import type { AgentOutput, DAOAgent, Proposal } from "../types/index.js";
import type { ModelResolutionContext } from "./model.js";
import { buildDispatchInstructions } from "./swarm.js";

/**
 * Content up to the first vote section: the analysis an agent produced,
 * stripped of its vote and reasoning so later voters stay independent.
 * Accepts exactly the heading variants the tally parser accepts
 * (VOTE_PATTERN in governance/voting.ts) — a vote the tally can parse must
 * never leak downstream.
 */
export function extractAnalysis(content: string): string {
  const voteIndex = content.search(/##\s*Vote\s*\n/i);
  const analysis = voteIndex === -1 ? content : content.slice(0, voteIndex);
  return analysis.trim();
}

export interface PriorAnalysesOptions {
  /** Maximum characters of analysis forwarded per prior agent. */
  charsPerAgent?: number;
}

const DEFAULT_CHARS_PER_AGENT = 1500;

/**
 * Build the "## Prior Analyses" section fed to the next agent in the
 * pipeline. Failed spawns (empty content) contribute nothing.
 */
export function buildPriorAnalysesSection(
  priorOutputs: readonly AgentOutput[],
  options: PriorAnalysesOptions = {},
): string {
  const limit = options.charsPerAgent ?? DEFAULT_CHARS_PER_AGENT;
  const entries = priorOutputs
    .filter((output) => output.content.trim().length > 0)
    .map((output) => {
      const analysis = extractAnalysis(output.content);
      const excerpt = analysis.length > limit ? `${analysis.slice(0, limit)}…` : analysis;
      return `- **@${output.agentId} (${output.agentName})**\n  ${excerpt.replace(/\n/g, "\n  ")}`;
    });
  if (entries.length === 0) return "";
  return `## Prior Analyses\n\nAgents before you have analyzed this proposal. Build on their work; do not repeat it. Your vote must stay your own.\n\n${entries.join("\n\n")}`;
}

export interface SequentialDispatchOptions extends PriorAnalysesOptions {
  onUpdate?: (update: { agentId: string; agentName: string; phase: "started" | "completed" | "error" }) => void;
  /** Shared project brief injected into every participant's prompt. */
  projectBrief?: string;
}

/**
 * Dispatch deliberation as a sequential pipeline: agents run in the given
 * order, each receiving the prior analyses (never votes). A failed spawn
 * records an error output and the pipeline continues — the deterministic
 * tally decides with whatever votes were produced, exactly as in parallel
 * dispatch.
 */
export async function dispatchSequentialSwarm(
  proposal: Proposal,
  agents: readonly DAOAgent[],
  adapter: AgentWorkerPort,
  modelContext: ModelResolutionContext,
  options: SequentialDispatchOptions = {},
): Promise<AgentOutput[]> {
  const instructions = buildDispatchInstructions(proposal, [...agents], modelContext, {
    projectBrief: options.projectBrief,
  });
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const outputs: AgentOutput[] = [];

  for (const instruction of instructions) {
    const agent = agentById.get(instruction.agentId);
    if (!agent) continue;

    options.onUpdate?.({ agentId: instruction.agentId, agentName: instruction.agentName, phase: "started" });

    const priorSection = buildPriorAnalysesSection(outputs, options);
    const prompt = priorSection ? `${instruction.prompt}\n\n${priorSection}` : instruction.prompt;

    let output: AgentOutput;
    try {
      output = await adapter.spawnAgent({
        agent,
        proposal,
        systemPrompt: prompt,
        model: instruction.model,
        timeoutMs: instruction.timeoutMs,
      });
    } catch (err: unknown) {
      output = {
        agentId: instruction.agentId,
        agentName: instruction.agentName,
        role: agent.role,
        content: "",
        durationMs: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }

    outputs.push(output);
    options.onUpdate?.({
      agentId: instruction.agentId,
      agentName: instruction.agentName,
      phase: output.error ? "error" : "completed",
    });
  }

  return outputs;
}
