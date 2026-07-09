// ============================================================
// Swarm DAO Core — Swarm Dispatch
// ============================================================

import { clearProposalCoordinators, registerProposalCoordinators } from "../governance/delegation.utils.js";
import type { AgentOutput, DAOAgent, DAOConfig, HostAdapter, Proposal } from "../types/index.js";
import { drainDelegations, runDelegations } from "./delegation.js";
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
 *
 * Delegation (DFI) is opt-in: pass `delegation?.config` with
 * `config.delegation.enabled === true` to activate. When active, after each
 * parent agent produces an output, declared facets are investigated by child
 * agents and folded into the parent's reasoning (INV-6: votes untouched). Live
 * coordinators are registered for the `delegation-closed` gate (INV-8) and
 * drained on completion.
 */
export async function dispatchSwarm(
  proposal: Proposal,
  agents: DAOAgent[],
  adapter: HostAdapter,
  maxConcurrent: number,
  modelContext: ModelResolutionContext,
  onUpdate?: (update: SwarmProgressUpdate) => void,
  delegation?: { config: DAOConfig },
): Promise<AgentOutput[]> {
  const instructions = buildDispatchInstructions(proposal, agents, modelContext);
  const outputs: AgentOutput[] = [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const delegationEnabled = delegation?.config?.delegation?.enabled === true;
  const allCoordinators: import("../governance/delegation.utils.js").DelegationCoordinatorState[] = [];
  const allRequests: import("../governance/delegation.utils.js").DelegationRequestState[] = [];

  // Process in batches based on maxConcurrent
  for (let i = 0; i < instructions.length; i += maxConcurrent) {
    const batch = instructions.slice(i, i + maxConcurrent);

    const batchPromises = batch.map(async (inst) => {
      const agent = agentById.get(inst.agentId);
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

        // DFI hook: fold declared delegations into the parent reasoning.
        if (delegationEnabled && delegation && !output.error) {
          const result = await runDelegations({
            parent: agent,
            parentOutput: output,
            proposal,
            adapter,
            config: delegation.config,
            parentModelContext: modelContext,
          });
          allCoordinators.push(...result.coordinators);
          allRequests.push(...result.requests);
          if (result.delegated) output.content = result.foldedContent;
        }

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

  if (delegationEnabled) {
    registerProposalCoordinators(proposal.id, allCoordinators);
    drainDelegations(allCoordinators, allRequests);
  }

  return outputs;
}

/** Clear the coordinator registry for a proposal once deliberation is over. */
export function resetDelegationRegistry(proposalId: number): void {
  clearProposalCoordinators(proposalId);
}
