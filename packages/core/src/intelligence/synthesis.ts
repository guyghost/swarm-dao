// ============================================================
// Swarm DAO Core — Deliberation Synthesis
// ============================================================

import type { Proposal, DAOAgent, AgentOutput, TallyResult } from "../types/index.js";

export function synthesize(
  proposal: Proposal,
  agents: DAOAgent[],
  outputs: AgentOutput[],
  tally?: TallyResult,
): string {
  const approved = tally?.approved ?? false;
  const forVotes = outputs.filter((o) => o.vote?.position === "for");
  const againstVotes = outputs.filter((o) => o.vote?.position === "against");
  const abstentions = outputs.filter((o) => o.vote?.position === "abstain" || !o.vote);
  const errors = outputs.filter((o) => o.error);

  let synthesis = `## Synthesis — Proposal #${proposal.id}\n\n`;

  synthesis += `**Result:** ${approved ? "✅ APPROVED" : "❌ REJECTED"}\n`;
  synthesis += `**Agents Participated:** ${outputs.length}\n`;
  synthesis += `**For:** ${forVotes.length} | **Against:** ${againstVotes.length} | **Abstain:** ${abstentions.length}`;

  if (errors.length > 0) {
    synthesis += ` | **Errors:** ${errors.length}`;
  }
  synthesis += "\n\n";

  if (forVotes.length > 0) {
    synthesis += "### Supporting Arguments\n";
    for (const vote of forVotes) {
      synthesis += `- **${vote.agentName}:** ${vote.vote?.reasoning?.slice(0, 200) ?? "No reasoning"}${(vote.vote?.reasoning?.length ?? 0) > 200 ? "..." : ""}\n`;
    }
    synthesis += "\n";
  }

  if (againstVotes.length > 0) {
    synthesis += "### Opposing Arguments\n";
    for (const vote of againstVotes) {
      synthesis += `- **${vote.agentName}:** ${vote.vote?.reasoning?.slice(0, 200) ?? "No reasoning"}${(vote.vote?.reasoning?.length ?? 0) > 200 ? "..." : ""}\n`;
    }
    synthesis += "\n";
  }

  if (errors.length > 0) {
    synthesis += "### Agent Errors\n";
    for (const err of errors) {
      synthesis += `- **${err.agentName}:** ${err.error}\n`;
    }
    synthesis += "\n";
  }

  // Key themes
  const allReasoning = outputs
    .filter((o) => o.vote?.reasoning)
    .map((o) => o.vote!.reasoning)
    .join(" ");

  const themes = extractThemes(allReasoning);
  if (themes.length > 0) {
    synthesis += "### Key Themes\n";
    for (const theme of themes) {
      synthesis += `- ${theme}\n`;
    }
    synthesis += "\n";
  }

  synthesis += "### Recommendation\n";
  if (approved) {
    synthesis += "The swarm recommends approving this proposal. Proceed to quality control gates.\n";
  } else {
    synthesis += "The swarm recommends rejecting this proposal. Review the opposing arguments and consider revising.\n";
  }

  return synthesis;
}

function extractThemes(text: string): string[] {
  // Simple keyword-based theme extraction
  const themes: string[] = [];
  const themeKeywords: Record<string, string[]> = {
    "Security concerns": ["security", "vulnerability", "exploit", "attack"],
    "Performance impact": ["performance", "latency", "slow", "bottleneck"],
    "User experience": ["ux", "user", "experience", "usability"],
    "Technical debt": ["debt", "legacy", "refactor", "cleanup"],
    "Scalability": ["scale", "scaling", "concurrent", "load"],
    "Maintenance burden": ["maintain", "support", "operational"],
    "Alignment": ["vision", "strategy", "roadmap", "goal"],
  };

  const lowerText = text.toLowerCase();
  for (const [theme, keywords] of Object.entries(themeKeywords)) {
    if (keywords.some((k) => lowerText.includes(k))) {
      themes.push(theme);
    }
  }

  return themes.slice(0, 5); // Max 5 themes
}

export function formatSynthesis(synthesis: string): string {
  return synthesis;
}