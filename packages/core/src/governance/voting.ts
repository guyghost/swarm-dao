// ============================================================
// Swarm DAO Core — Vote Parsing & Tally
// ============================================================

import type { AgentOutput, DAOConfig, Proposal, TallyResult, Vote, VotePosition } from "../types/index.js";

// ── Vote Parsing ─────────────────────────────────────────────

const VOTE_PATTERN = /##\s*Vote\s*\n\s*(for|against|abstain)/i;
const REASONING_PATTERN = /##\s*Reasoning\s*\n\s*([\s\S]*?)(?=\n##|$)/i;

export function parseVoteFromOutput(
  agentId: string,
  agentName: string,
  weight: number,
  content: string,
): Vote | undefined {
  const voteMatch = content.match(VOTE_PATTERN);
  const reasoningMatch = content.match(REASONING_PATTERN);

  const position = (voteMatch?.[1]?.toLowerCase() as VotePosition) || "abstain";
  const reasoning = reasoningMatch?.[1]?.trim() || "No reasoning provided";

  return {
    agentId,
    agentName,
    position,
    reasoning,
    weight,
  };
}

export function parseVoteFromAgentOutput(output: AgentOutput): Vote | undefined {
  if (!output.content) return undefined;
  return parseVoteFromOutput(output.agentId, output.agentName, 0, output.content);
}

// ── Tally ────────────────────────────────────────────────────

export function tallyVotes(proposal: Proposal, config: DAOConfig): TallyResult {
  const votes = proposal.votes || [];
  const totalAgents = proposal.agentOutputs?.length || votes.length;

  const weightedFor = votes.filter((v) => v.position === "for").reduce((sum, v) => sum + v.weight, 0);

  const weightedAgainst = votes.filter((v) => v.position === "against").reduce((sum, v) => sum + v.weight, 0);

  const weightedAbstain = votes.filter((v) => v.position === "abstain").reduce((sum, v) => sum + v.weight, 0);

  const totalVotingWeight = weightedFor + weightedAgainst + weightedAbstain;
  const votingAgents = votes.filter((v) => v.position !== "abstain").length;

  // Quorum check: % of total agent weight that participated
  const totalPossibleWeight =
    totalAgents > 0
      ? votes.reduce((sum, v) => sum + v.weight, 0) + (totalAgents - votes.length) * 1
      : totalVotingWeight;

  const quorumPercent = totalPossibleWeight > 0 ? Math.round((totalVotingWeight / totalPossibleWeight) * 100) : 0;

  const quorumMet = quorumPercent >= config.quorumPercent;

  // Approval: % of non-abstain weight that voted for
  const decisiveWeight = weightedFor + weightedAgainst;
  const approvalScore = decisiveWeight > 0 ? Math.round((weightedFor / decisiveWeight) * 100) : 0;

  const approved = quorumMet && approvalScore >= config.approvalThreshold;

  return {
    proposalId: proposal.id,
    approved,
    quorumMet,
    totalAgents,
    votingAgents,
    quorumPercent,
    weightedFor,
    weightedAgainst,
    totalVotingWeight,
    approvalScore,
    votes,
  };
}

export function formatTallyResult(tally: TallyResult): string {
  const status = tally.approved ? "✅ APPROVED" : "❌ REJECTED";
  const quorumStatus = tally.quorumMet ? "✅ Met" : "❌ Not met";

  return `## Vote Tally — #${tally.proposalId}

**Result:** ${status}
**Quorum:** ${tally.quorumPercent}% / ${quorumStatus}
**Approval Score:** ${tally.approvalScore}%
**Votes Cast:** ${tally.votingAgents} / ${tally.totalAgents} agents
**Weighted For:** ${tally.weightedFor}
**Weighted Against:** ${tally.weightedAgainst}

### Vote Breakdown
${tally.votes.map((v) => `- ${v.agentName}: **${v.position}** (w=${v.weight}) — ${v.reasoning.slice(0, 100)}${v.reasoning.length > 100 ? "..." : ""}`).join("\n")}`;
}
