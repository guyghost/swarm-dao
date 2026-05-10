// ============================================================
// Swarm DAO Core — Swarm Dispatch
// ============================================================

import type { DAOAgent, Proposal, AgentOutput, HostAdapter } from "../types/index.js";

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
  model?: string;
  timeoutMs: number;
}

/**
 * Build dispatch instructions for each agent.
 * Host adapters use these to spawn sub-agents.
 */
export function buildDispatchInstructions(proposal: Proposal, agents: DAOAgent[]): DispatchInstruction[] {
  const basePrompt = `You are participating in DAO governance deliberation for the following proposal.

## Proposal #${proposal.id}: ${proposal.title}
**Type:** ${proposal.type}
**Description:**
${proposal.description}

${proposal.problemStatement ? `**Problem Statement:**\n${proposal.problemStatement}\n\n` : ""}
${proposal.context ? `**Context:**\n${proposal.context}\n\n` : ""}
${Array.isArray(proposal.acceptanceCriteria) && proposal.acceptanceCriteria.length > 0
    ? `**Acceptance Criteria:**\n${proposal.acceptanceCriteria.map((ac, i) => `- ${typeof ac === "string" ? ac : ac.id}: ${typeof ac === "string" ? ac : `${ac.given} / ${ac.when} / ${ac.then}`}`).join("\n")}\n\n`
    : ""}
${proposal.successMetrics?.length ? `**Success Metrics:**\n${proposal.successMetrics.map((m) => `- ${m}`).join("\n")}\n\n` : ""}

Evaluate this proposal carefully. Provide your analysis, vote, and scoring.`;

  return agents.map((agent) => ({
    agentId: agent.id,
    agentName: agent.name,
    prompt: `${agent.systemPrompt}\n\n${basePrompt}`,
    model: agent.model,
    timeoutMs: 120_000,
  }));
}

export function formatDispatchPlan(proposal: Proposal, instructions: DispatchInstruction[]): string {
  return `# 🐝 Swarm Dispatch Plan — Proposal #${proposal.id}

**Title:** ${proposal.title}
**Agents to spawn:** ${instructions.length}

## Instructions
${instructions.map((inst) => `### @${inst.agentId} (${inst.agentName})
- Model: ${inst.model ?? "default"}
- Timeout: ${inst.timeoutMs}ms

Spawn this sub-agent with the following task:
\`\`\`
${inst.prompt.slice(0, 500)}${inst.prompt.length > 500 ? "..." : ""}
\`\`\`
`).join("\n")}

## Next Step
After collecting all outputs, call \`dao_record_outputs\` with the collected responses.`;
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
  onUpdate?: (update: SwarmProgressUpdate) => void,
): Promise<AgentOutput[]> {
  const instructions = buildDispatchInstructions(proposal, agents);
  const outputs: AgentOutput[] = [];

  // Process in batches based on maxConcurrent
  for (let i = 0; i < instructions.length; i += maxConcurrent) {
    const batch = instructions.slice(i, i + maxConcurrent);

    const batchPromises = batch.map(async (inst) => {
      const agent = agents.find((a) => a.id === inst.agentId)!;

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
      } catch (err: any) {
        const errorOutput: AgentOutput = {
          agentId: inst.agentId,
          agentName: inst.agentName,
          role: agent.role,
          content: "",
          durationMs: 0,
          error: err.message || "Unknown error",
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