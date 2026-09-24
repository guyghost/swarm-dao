// ============================================================
// Swarm DAO Core — Vote Parsing & Tally
// ============================================================

import type {
  AgentOutput,
  DAOAgent,
  DAOConfig,
  Proposal,
  TallyResult,
  TypeQuorumConfig,
  Vote,
  VotePosition,
} from "../types/index.js";
import { TYPE_QUORUM } from "../types/index.js";

/** Resolve the quorum/approval bar for a proposal type (config override, then TYPE_QUORUM, then globals). */
export function resolveTypeThresholds(proposal: Proposal, config: DAOConfig): TypeQuorumConfig {
  const typed = config.typeQuorum[proposal.type] ?? TYPE_QUORUM[proposal.type];
  return {
    quorumPercent: typed?.quorumPercent ?? config.quorumPercent,
    approvalPercent: typed?.approvalPercent ?? config.approvalThreshold,
    description: typed?.description ?? proposal.type,
  };
}

// ── Vote Parsing ─────────────────────────────────────────────

// Line-oriented extraction (ReDoS-safe): sections are located by scanning
// lines — heading patterns only use [ \t] classes so no quantifier can cross
// a newline, and bodies are collected line by line instead of
// [\s\S]*? + lookahead alternations.
// Headings accept both the charter's raw form (`## Vote`) and the form a
// rendering TUI leaves on screen (`Vote`, `  Vote:`) — hosts like herdr
// harvest the RENDERED terminal text, where the `##` glyphs are gone
// (issue #178). The optional `(?:##[ \t]*)?` is [ \t]-only, so no quantifier
// can cross a newline.
const VOTE_HEADING = /^[ \t]*(?:##[ \t]*)?vote[ \t:]*$/i;
const VOTE_WORD = /^(for|against|abstain)$/i;

/** True for a line that opens a vote section. Exported as the single source of
 *  truth for "a line the tally parses as a vote heading": the sequential
 *  pipeline strips everything from this line on before forwarding an analysis,
 *  so it must accept exactly the same variants (raw `## Vote` AND the rendered
 *  `Vote`/`Vote:` form a host TUI leaves on screen — issue #178). */
export function isVoteHeadingLine(line: string): boolean {
  return VOTE_HEADING.test(line);
}
const REASONING_HEADING = /^[ \t]*(?:##[ \t]*)?reasoning[ \t:]*$/i;
const DELEGATED_FACETS_HEADING = /^##[ \t]*delegated[ \t]+facets[ \t]*$/i;
const FENCE = /^[ \t]*```/;

/** Drop folded child output so a child's `## Vote` can never become the
 *  parent's (INV-6). The orchestrator appends children after this heading. */
function parentSignalContent(content: string): string {
  const lines = content.split("\n");
  const cut = lines.findIndex((line) => DELEGATED_FACETS_HEADING.test(line));
  return cut < 0 ? content : lines.slice(0, cut).join("\n");
}

/** Body lines after the first unfenced `heading`, up to the next "##". */
function sectionLines(content: string, heading: RegExp): string[] | null {
  const lines = content.split("\n");
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (start < 0 && heading.test(line)) {
      start = i;
      continue;
    }
    if (start >= 0 && /^##/.test(line)) return lines.slice(start + 1, i);
  }
  return start < 0 ? null : lines.slice(start + 1);
}

/** Position from the first unfenced "## Vote" whose first non-empty body
 *  line is exclusively `for`, `against`, or `abstain`. Placeholders
 *  (`for | against | abstain`, `<for|against|abstain>`) and fenced
 *  examples are skipped so they cannot shadow a later real vote. */
function extractVotePosition(content: string): VotePosition | undefined {
  const lines = content.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !VOTE_HEADING.test(line)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j] ?? "";
      if (/^##/.test(body)) break;
      const trimmed = body.trim();
      if (trimmed.length === 0) continue;
      const match = trimmed.match(VOTE_WORD);
      if (match?.[1]) return match[1].toLowerCase() as VotePosition;
      break;
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
  const signal = parentSignalContent(content);
  const position = extractVotePosition(signal);
  // No vote section → no fabricated vote: agents that did not vote must not
  // dilute the tally with template abstentions (and don't count toward quorum).
  if (!position) return undefined;

  const reasoning = sectionLines(signal, REASONING_HEADING)?.join("\n").trim() || "No reasoning provided";

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

/**
 * The voting electorate: configured council members and their weights.
 * Callers that know the DAO's agent roster pass it explicitly; tallyVotes
 * never guesses an electorate from agentOutputs alone (issue #155).
 */
export type Electorate = ReadonlyArray<Pick<DAOAgent, "id" | "weight">>;

export function tallyVotes(proposal: Proposal, config: DAOConfig, electorate?: Electorate): TallyResult {
  const votes = proposal.votes || [];

  // Single pass over votes: accumulate weighted totals + voting-agent count.
  let weightedFor = 0;
  let weightedAgainst = 0;
  let weightedAbstain = 0;
  let votingAgents = 0;

  for (const v of votes) {
    const w = normalizeVoteWeight(v.weight);
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

  // Quorum denominator: the full configured electorate's weight, plus the
  // weight of votes cast from outside the electorate (e.g. human votes).
  // Silent (non-voting) council members carry their CONFIGURED weight, not a
  // flat 1 (issue #155a). When no electorate is known, fall back to the
  // distinct voting agent ids at weight 1 — best effort only.
  let totalPossibleWeight: number;
  let totalAgents: number;
  if (electorate && electorate.length > 0) {
    const electorIds = new Set(electorate.map((agent) => agent.id));
    totalAgents = electorate.length;
    const electorateWeight = electorate.reduce((sum, agent) => sum + normalizeVoteWeight(agent.weight), 0);
    let outsideWeight = 0;
    for (const v of votes) {
      if (!electorIds.has(v.agentId)) outsideWeight += normalizeVoteWeight(v.weight);
    }
    totalPossibleWeight = electorateWeight + outsideWeight;
  } else {
    totalAgents = proposal.agentOutputs?.length || new Set(votes.map((v) => v.agentId)).size;
    totalPossibleWeight = totalVotingWeight;
  }
  // By construction the denominator can never undercut the votes actually cast.
  totalPossibleWeight = Math.max(totalPossibleWeight, totalVotingWeight);

  // Exact fraction comparisons (issue #156): rounding happens only for the
  // reported percentages, never for the decision. Math.round(66.67) = 67
  // must not clear a 67% bar.
  const quorumPercent = totalPossibleWeight > 0 ? Math.round((totalVotingWeight / totalPossibleWeight) * 100) : 0;

  const thresholds = resolveTypeThresholds(proposal, config);
  const quorumMet = totalVotingWeight * 100 >= thresholds.quorumPercent * totalPossibleWeight;

  // Approval: % of non-abstain weight that voted for
  const decisiveWeight = weightedFor + weightedAgainst;
  const approvalScore = decisiveWeight > 0 ? Math.round((weightedFor / decisiveWeight) * 100) : 0;

  const approved = quorumMet && decisiveWeight > 0 && weightedFor * 100 >= thresholds.approvalPercent * decisiveWeight;

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
