// ============================================================
// Swarm DAO Core — Vote Parsing & Tally
// ============================================================

import type { AgentOutput, DAOConfig, Proposal, TallyResult, Vote, VotePosition } from "../types/index.js";

// ── Vote Parsing ─────────────────────────────────────────────

// Line-oriented extraction (ReDoS-safe): sections are located by scanning
// lines — heading patterns only use [ \t] classes so no quantifier can cross
// a newline, and bodies are collected line by line instead of
// [\s\S]*? + lookahead alternations.
const VOTE_HEADING = /^##[ \t]*vote[ \t]*$/i;
const VOTE_WORD = /^(for|against|abstain)\b/i;
const REASONING_HEADING = /^##[ \t]*reasoning[ \t]*$/i;

/** Body lines after the `heading` line, up to the next line-anchored "##". */
function sectionLines(content: string, heading: RegExp): string[] | null {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /^##/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/** Position from the first "## Vote" section that actually carries a vote
 *  word — echoed template sections (stripped of their vote line) must not
 *  shadow the agent's real answer further down the transcript. */
function extractVotePosition(content: string): VotePosition | undefined {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!VOTE_HEADING.test(lines[i] ?? "")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j] ?? "";
      if (/^##/.test(body)) break;
      const match = body.trim().match(VOTE_WORD);
      if (match?.[1]) return match[1].toLowerCase() as VotePosition;
    }
  }
  return undefined;
}

function normalizeVoteWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

export function parseVoteFromOutput(
  agentId: string,
  agentName: string,
  weight: number,
  content: string,
): Vote | undefined {
  const position = extractVotePosition(content);
  // No vote section → no fabricated vote: agents that did not vote must not
  // dilute the tally with template abstentions (and don't count toward quorum).
  if (!position) return undefined;

  const reasoning = sectionLines(content, REASONING_HEADING)?.join("\n").trim() || "No reasoning provided";

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
