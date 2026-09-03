// ============================================================
// Swarm DAO Core — Vote Parsing & Tally
// ============================================================

import type { AgentOutput, DAOConfig, Proposal, TallyResult, Vote, VotePosition } from "../types/index.js";

// ── Vote Parsing ─────────────────────────────────────────────

const VOTE_PATTERN = /##\s*Vote\s*\n\s*(for|against|abstain)/i;
const REASONING_PATTERN = /##\s*Reasoning\s*\n\s*([\s\S]*?)(?=\n##|$)/i;

function normalizeVoteWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

export function parseVoteFromOutput(
  agentId: string,
  agentName: string,
  weight: number,
  content: string,
): Vote | undefined {
  const voteMatch = content.match(VOTE_PATTERN);
  // No vote section → no fabricated vote: agents that did not vote must not
  // dilute the tally with template abstentions (and don't count toward quorum).
  if (!voteMatch) return undefined;
  const reasoningMatch = content.match(REASONING_PATTERN);

  const position = (voteMatch[1]?.toLowerCase() as VotePosition) || "abstain";
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

/**
 * Merge a fresh round of agent votes into the proposal's existing votes
 * (human/CLI votes cast before deliberation, or votes from earlier rounds).
 * Incoming votes replace any prior vote from the SAME agent only; every other
 * existing vote is preserved.
 */
export function mergeVotes(existing: Vote[] | undefined, incoming: Vote[]): Vote[] {
  const incomingIds = new Set(incoming.map((vote) => vote.agentId));
  const preserved = (existing ?? []).filter((vote) => !incomingIds.has(vote.agentId));
  return [...preserved, ...incoming];
}

export function tallyVotes(proposal: Proposal, config: DAOConfig): TallyResult {
  const votes = proposal.votes || [];
  const totalAgents = proposal.agentOutputs?.length || votes.length;

  // Single pass over votes: accumulate weighted totals + voting-agent count.
  let weightedFor = 0;
  let weightedAgainst = 0;
  let weightedAbstain = 0;
  let totalObservedWeight = 0;
  let votingAgents = 0;

  for (const v of votes) {
    const w = normalizeVoteWeight(v.weight);
    totalObservedWeight += w;
    if (v.position === "for") {
      weightedFor += w;
      votingAgents++;
    } else if (v.position === "against") {
      weightedAgainst += w;
      votingAgents++;
    } else {
      weightedAbstain += w;
    }
  }

  const totalVotingWeight = weightedFor + weightedAgainst + weightedAbstain;

  // Quorum check: % of total agent weight that participated.
  // Unobserved agents (totalAgents - votes.length) each contribute default weight 1.
  const totalPossibleWeight =
    totalAgents > 0 ? totalObservedWeight + (totalAgents - votes.length) * 1 : totalVotingWeight;

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
