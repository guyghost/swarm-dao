// ============================================================
// Swarm DAO Core — Swarm Dispatch
// ============================================================

import type { AgentOutput, DAOAgent, HostAdapter, Proposal } from "../types/index.js";
import {
  buildModelResolutionContext,
  describeModelResolution,
  type ModelResolutionContext,
  resolveAgentModel,
} from "./model.js";

export interface SwarmProgressUpdate {
  agentId: string;
  agentName: string;
  phase: "pending" | "started" | "completed" | "error";
  output?: AgentOutput;
  isRetry?: boolean;
}

export interface DispatchInstruction {
  agentId: string;
  agentName: string;
  prompt: string;
  model: string;
  modelDescription: string;
  timeoutMs: number;
}

/**
 * Build dispatch instructions for each agent.
 * Host adapters use these to spawn sub-agents.
 */
export function buildDispatchInstructions(
  proposal: Proposal,
  agents: DAOAgent[],
  modelContext: ModelResolutionContext,
): DispatchInstruction[] {
  const basePrompt = `You are participating in DAO governance deliberation for the following proposal.

## Proposal #${proposal.id}: ${proposal.title}
**Type:** ${proposal.type}
**Description:**
${proposal.description}

${proposal.problemStatement ? `**Problem Statement:**\n${proposal.problemStatement}\n\n` : ""}
${proposal.context ? `**Context:**\n${proposal.context}\n\n` : ""}
${
  Array.isArray(proposal.acceptanceCriteria) && proposal.acceptanceCriteria.length > 0
    ? `**Acceptance Criteria:**\n${proposal.acceptanceCriteria.map((ac, _i) => `- ${typeof ac === "string" ? ac : ac.id}: ${typeof ac === "string" ? ac : `${ac.given} / ${ac.when} / ${ac.then}`}`).join("\n")}\n\n`
    : ""
}
${proposal.successMetrics?.length ? `**Success Metrics:**\n${proposal.successMetrics.map((m) => `- ${m}`).join("\n")}\n\n` : ""}

Evaluate this proposal carefully. Provide your analysis, vote, and scoring.`;

  return agents.map((agent) => {
    const model = resolveAgentModel(agent, modelContext);
    return {
      agentId: agent.id,
      agentName: agent.name,
      prompt: `${agent.systemPrompt}\n\n${basePrompt}`,
      model,
      modelDescription: describeModelResolution(agent, model, modelContext),
      timeoutMs: 120_000,
    };
  });
}

export function formatDispatchPlan(proposal: Proposal, instructions: DispatchInstruction[]): string {
  return `# 🐝 Swarm Dispatch Plan — Proposal #${proposal.id}

**Title:** ${proposal.title}
**Agents to spawn:** ${instructions.length}

## Instructions
${instructions
  .map(
    (inst) => `### @${inst.agentId} (${inst.agentName})
- Model: ${inst.modelDescription}
- Timeout: ${inst.timeoutMs}ms

Spawn this sub-agent with the following task (use \`task\` with \`model="${inst.model}"\` when available):
\`\`\`
${inst.prompt.slice(0, 500)}${inst.prompt.length > 500 ? "..." : ""}
\`\`\`
`,
  )
  .join("\n")}

## Next Step
After collecting all outputs, call \`dao_record_outputs\` with the collected responses.`;
}

export function createDispatchModelContext(
  configDefaultModel: string,
  adapter: HostAdapter,
  options?: { hostDefaultModel?: string; parentSessionModel?: string },
): ModelResolutionContext {
  return buildModelResolutionContext(configDefaultModel, {
    parentSessionModel: options?.parentSessionModel ?? adapter.getSessionModel?.(),
    hostDefaultModel: options?.hostDefaultModel,
  });
}

/**
 * Dispatch swarm via a host adapter.
 * This is the host-agnostic version — adapters implement the actual spawning.
 */
export async function dispatchSwarm(
  proposal: Proposal,
  agents: DAOAgent[],
  adapter: HostAdapter,
  maxConcurrent: number,
  modelContext: ModelResolutionContext,
  onUpdate?: (update: SwarmProgressUpdate) => void,
): Promise<AgentOutput[]> {
  const instructions = buildDispatchInstructions(proposal, agents, modelContext);
  const outputs: AgentOutput[] = [];

  // Process in batches based on maxConcurrent
  for (let i = 0; i < instructions.length; i += maxConcurrent) {
    const batch = instructions.slice(i, i + maxConcurrent);

    const batchPromises = batch.map(async (inst) => {
      const agent = agents.find((a) => a.id === inst.agentId);
      if (!agent) throw new Error(`Agent ${inst.agentId} not found`);

      onUpdate?.({
        agentId: inst.agentId,
        agentName: inst.agentName,
        phase: "started",
      });

      try {
        const output = await adapter.spawnAgent({
          agent,
          proposal,
          systemPrompt: inst.prompt,
          model: inst.model,
          timeoutMs: inst.timeoutMs,
        });

        outputs.push(output);

        onUpdate?.({
          agentId: inst.agentId,
          agentName: inst.agentName,
          phase: output.error ? "error" : "completed",
          output,
        });

        return output;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const errorOutput: AgentOutput = {
          agentId: inst.agentId,
          agentName: inst.agentName,
          role: agent.role,
          content: "",
          durationMs: 0,
          error: message,
        };
        outputs.push(errorOutput);

        onUpdate?.({
          agentId: inst.agentId,
          agentName: inst.agentName,
          phase: "error",
          output: errorOutput,
        });

        return errorOutput;
      }
    });

    await Promise.all(batchPromises);
  }

  return outputs;
}
