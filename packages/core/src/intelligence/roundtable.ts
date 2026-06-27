// ============================================================
// Swarm DAO Core — Round Table (Agents suggest proposals)
// ============================================================

import type { DAOAgent, HostAdapter, ProposalType } from "../types/index.js";
import { PROPOSAL_TYPE, PROPOSAL_TYPES } from "../types/index.js";
import { resolveAgentModel, type ModelResolutionContext } from "./model.js";

export interface RoundTableSuggestion {
  agentId: string;
  agentName: string;
  content: string;
  parsed?: {
    title: string;
    type: ProposalType;
    description: string;
  };
  proposalId?: number;
  error?: string;
}

const SUGGESTION_PROMPT = `You are participating in a DAO Round Table.

Your task: suggest ONE concrete proposal that would improve the project.

Analyze the current codebase and suggest something specific, actionable, and valuable.

Output format:
## Suggested Proposal
**Title:** [short title]
**Type:** [product-feature | security-change | technical-change | release-change | governance-change]
**Description:** [2-3 sentences describing what and why]

Be specific. Reference actual files, patterns, or problems if you can.`;

export async function runRoundTable(
  adapter: HostAdapter,
  agents: DAOAgent[],
  maxConcurrent: number,
  modelContext: ModelResolutionContext,
): Promise<RoundTableSuggestion[]> {
  const suggestions: RoundTableSuggestion[] = [];

  // Process in batches
  for (let i = 0; i < agents.length; i += maxConcurrent) {
    const batch = agents.slice(i, i + maxConcurrent);

    const batchPromises = batch.map(async (agent) => {
      try {
        const output = await adapter.spawnAgent({
          agent,
          proposal: {
            id: 0,
            title: "Round Table Suggestions",
            type: PROPOSAL_TYPE.GOVERNANCE_CHANGE,
            description: "Agents suggest proposals",
            proposedBy: "system",
            status: "open",
            votes: [],
            agentOutputs: [],
            createdAt: new Date().toISOString(),
          },
          systemPrompt: `${agent.systemPrompt}\n\n${SUGGESTION_PROMPT}`,
          model: resolveAgentModel(agent, modelContext),
          timeoutMs: 60_000,
        });

        const parsed = parseSuggestion(output.content);
        const suggestion: RoundTableSuggestion = {
          agentId: agent.id,
          agentName: agent.name,
          content: output.content,
          parsed: parsed || undefined,
        };
        suggestions.push(suggestion);
        return suggestion;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const suggestion: RoundTableSuggestion = {
          agentId: agent.id,
          agentName: agent.name,
          content: "",
          error: message,
        };
        suggestions.push(suggestion);
        return suggestion;
      }
    });

    await Promise.all(batchPromises);
  }

  return suggestions;
}

function parseSuggestion(content: string): { title: string; type: ProposalType; description: string } | null {
  const titleMatch = content.match(/\*\*Title:\*\*\s*(.+)/i);
  const typeMatch = content.match(/\*\*Type:\*\*\s*(.+)/i);
  const descMatch = content.match(/\*\*Description:\*\*\s*([\s\S]*?)(?=\n##|$)/i);

  if (!titleMatch || !typeMatch) return null;

  const type = typeMatch[1]?.trim().toLowerCase() ?? "";
  if (!PROPOSAL_TYPES.includes(type as ProposalType)) return null;

  return {
    title: titleMatch[1]?.trim() ?? "",
    type: type as ProposalType,
    description: descMatch?.[1]?.trim() ?? titleMatch[1]?.trim() ?? "",
  };
}

export function formatRoundTableResults(
  suggestions: RoundTableSuggestion[],
  _proposalIds?: Map<string, number>,
  proposalTitles?: Map<number, string>,
): string {
  let output = "# 🎯 Round Table Results\n\n";

  const valid = suggestions.filter((s) => s.parsed);
  const invalid = suggestions.filter((s) => !s.parsed && !s.error);
  const errors = suggestions.filter((s) => s.error);

  output += `**Suggestions:** ${valid.length} valid / ${invalid.length} unparsed / ${errors.length} errors\n\n`;

  for (const s of valid) {
    output += `## ${s.agentName} (@${s.agentId})\n`;
    output += `**Title:** ${s.parsed?.title}\n`;
    output += `**Type:** ${s.parsed?.type}\n`;
    output += `**Description:** ${s.parsed?.description}\n`;
    if (s.proposalId && proposalTitles) {
      output += `**Created:** Proposal #${s.proposalId}\n`;
    }
    output += "\n";
  }

  if (invalid.length > 0) {
    output += "## Unparsed Suggestions\n";
    for (const s of invalid) {
      output += `- ${s.agentName}: Could not parse output\n`;
    }
    output += "\n";
  }

  if (errors.length > 0) {
    output += "## Errors\n";
    for (const s of errors) {
      output += `- ${s.agentName}: ${s.error}\n`;
    }
  }

  return output;
}
