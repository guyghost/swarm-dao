// ============================================================
// Swarm DAO Core — Swarm Dispatch
// ============================================================

import {
  clearDelegationInFlight,
  clearProposalCoordinators,
  markDelegationInFlight,
  registerProposalCoordinators,
} from "../governance/delegation.utils.js";
import type { AgentWorkerPort } from "../ports/host.js";
import type { AgentOutput, DAOAgent, DAOConfig, Proposal } from "../types/index.js";
import { drainDelegations, runDelegations } from "./delegation.js";
import {
  buildModelResolutionContext,
  describeModelResolution,
  type ModelResolutionContext,
  resolveAgentModel,
} from "./model.js";
import { describeHarnessResolution, type RuntimeResolutionContext, resolveAgentRuntime } from "./runtime.js";

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
  harness?: string;
  harnessDescription?: string;
  harnessWarning?: string;
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
  options: { projectBrief?: string; runtime?: RuntimeResolutionContext } = {},
): DispatchInstruction[] {
  const brief = options.projectBrief?.trim();
  const briefSection = brief ? `${brief}\n\n` : "";
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
${briefSection}Evaluate this proposal carefully. Provide your analysis, vote, and scoring.`;

  return agents.map((agent) => {
    const model = resolveAgentModel(agent, modelContext);
    let harness: string | undefined;
    let harnessDescription: string | undefined;
    let harnessWarning: string | undefined;
    if (options.runtime) {
      const resolution = resolveAgentRuntime(agent, model, options.runtime);
      if (resolution.ok) {
        harness = resolution.runtime.harness;
        harnessDescription = describeHarnessResolution({
          harness: resolution.runtime.harness,
          source: resolution.runtime.harnessSource,
        });
      } else {
        harnessWarning = `⚠️ ${resolution.message}`;
      }
    }
    return {
      agentId: agent.id,
      agentName: agent.name,
      prompt: `${agent.systemPrompt}\n\n${basePrompt}`,
      model,
      modelDescription: describeModelResolution(agent, model, modelContext),
      harness,
      harnessDescription,
      harnessWarning,
      timeoutMs: 240_000,
    };
  });
}

export function formatDispatchPlan(
  proposal: Proposal,
  instructions: DispatchInstruction[],
  options: { strategy?: "parallel" | "sequential"; charsPerAgent?: number } = {},
): string {
  const sequentialNote =
    options.strategy === "sequential"
      ? `## Sequential Pipeline

This project deliberates sequentially. Run the agents **in the listed order, one at a time**. Before spawning agent N, append to its prompt a \`## Prior Analyses\` section built from agents 1..N-1: each entry is the agent's id, name, and its analysis (content up to the \`## Vote\` heading${options.charsPerAgent ? `, capped at ${options.charsPerAgent} characters` : ""}). **Never forward votes or reasoning** — the tally must stay independent. Collect every output and record them together via \`dao_record_outputs\`.

`
      : "";
  return `# 🐝 Swarm Dispatch Plan — Proposal #${proposal.id}

**Title:** ${proposal.title}
**Agents to spawn:** ${instructions.length}

${sequentialNote}## Instructions
${instructions
  .map(
    (inst) => `### @${inst.agentId} (${inst.agentName})
- Model: ${inst.modelDescription}
${inst.harness ? `- Harness: ${inst.harnessDescription ?? inst.harness}\n` : ""}${inst.harnessWarning ? `${inst.harnessWarning}\n` : ""}- Timeout: ${inst.timeoutMs}ms

Spawn this sub-agent with the following task (use \`task\` with \`model="${inst.model}"\` when available):
\`\`\`
${inst.prompt}
\`\`\`
`,
  )
  .join("\n")}

## Next Step
After collecting all outputs, call \`dao_record_outputs\` with the collected responses.`;
}

export function createDispatchModelContext(
  adapter: AgentWorkerPort,
  options?: { hostDefaultModel?: string; parentSessionModel?: string },
): ModelResolutionContext {
  return buildModelResolutionContext({
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
  adapter: AgentWorkerPort,
  maxConcurrent: number,
  modelContext: ModelResolutionContext,
  onUpdate?: (update: SwarmProgressUpdate) => void,
  /** `daoRoot` persists a cross-process in-flight marker so the
   *  delegation-closed gate can actually block while delegations run (#159). */
  delegation?: { config: DAOConfig; daoRoot?: string },
  options?: { projectBrief?: string; runtime?: RuntimeResolutionContext },
): Promise<AgentOutput[]> {
  const instructions = buildDispatchInstructions(proposal, agents, modelContext, options);
  const outputs: AgentOutput[] = [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const delegationEnabled = delegation?.config?.delegation?.enabled === true;
  const allCoordinators: import("../governance/delegation.utils.js").DelegationCoordinatorState[] = [];
  const allRequests: import("../governance/delegation.utils.js").DelegationRequestState[] = [];

  // Register the mutable coordinators array up-front so the delegation-closed
  // gate can observe in-flight coordinators as they are pushed during dispatch.
  if (delegationEnabled) {
    registerProposalCoordinators(proposal.id, allCoordinators);
    if (delegation?.daoRoot) {
      await markDelegationInFlight(delegation.daoRoot, proposal.id);
    }
  }

  try {
    // Process in batches based on maxConcurrent
    for (let i = 0; i < instructions.length; i += maxConcurrent) {
      const batch = instructions.slice(i, i + maxConcurrent);

      const batchPromises = batch.map(async (inst) => {
        const agent = agentById.get(inst.agentId);
        try {
          if (!agent) throw new Error(`Agent ${inst.agentId} not found`);

          onUpdate?.({
            agentId: inst.agentId,
            agentName: inst.agentName,
            phase: "started",
          });

          // Runtime resolution (models/agent-runtime.md): a typed failure
          // produces a per-agent error output — never a throw across the
          // dispatch loop, never a silent model drop.
          let harness: string | undefined;
          if (options?.runtime) {
            const resolution = resolveAgentRuntime(agent, inst.model, options.runtime);
            if (!resolution.ok) {
              const errorOutput: AgentOutput = {
                agentId: inst.agentId,
                agentName: inst.agentName,
                role: agent.role,
                content: "",
                durationMs: 0,
                error: resolution.message,
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
            harness = resolution.runtime.harness;
          } else {
            harness = agent.harness;
          }

          const output = await adapter.spawnAgent({
            agent,
            proposal,
            systemPrompt: inst.prompt,
            model: inst.model,
            harness,
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
              onCoordinatorCreated: (coordinator) => {
                allCoordinators.push(coordinator);
              },
            });
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
            role: agent?.role ?? "unknown",
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
  } finally {
    if (delegationEnabled) {
      drainDelegations(allCoordinators, allRequests);
      clearProposalCoordinators(proposal.id);
      if (delegation?.daoRoot) {
        await clearDelegationInFlight(delegation.daoRoot, proposal.id);
      }
    }
  }

  return outputs;
}

/** Clear the coordinator registry for a proposal once deliberation is over. */
export function resetDelegationRegistry(proposalId: number): void {
  clearProposalCoordinators(proposalId);
}
