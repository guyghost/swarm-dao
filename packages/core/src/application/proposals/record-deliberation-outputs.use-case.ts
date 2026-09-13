import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import { calculateCompositeScore } from "../../governance/scoring.js";
import { mergeVotes, parseVoteFromOutput, tallyVotes } from "../../governance/voting.js";
import { synthesize } from "../../intelligence/synthesis.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AgentOutput, AuditEntry, Vote } from "../../types/index.js";
import type { DeliberateProposalResult } from "./deliberate-proposal.use-case.js";

export interface RecordedAgentOutput {
  agentId: string;
  content: string;
  durationMs?: number;
  error?: string;
}

export class RecordDeliberationOutputsUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: {
    proposalId: number;
    outputs: RecordedAgentOutput[];
  }): Promise<DeliberateProposalResult> {
    const state = this.dependencies.repository.get();
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };
    if (proposal.status !== "deliberating") {
      return { ok: false, error: `Expected deliberating (current: ${proposal.status})` };
    }

    if (command.outputs.length === 0) {
      return { ok: false, error: "No agent outputs provided." };
    }
    const unknownIds = [
      ...new Set(
        command.outputs.map((raw) => raw.agentId).filter((id) => !state.agents.some((agent) => agent.id === id)),
      ),
    ];
    if (unknownIds.length > 0) {
      return {
        ok: false,
        error: `Unknown agent id(s): ${unknownIds.join(", ")}. Outputs were not recorded.`,
      };
    }

    const votes: Vote[] = [];
    const outputs: AgentOutput[] = [];
    for (const raw of command.outputs) {
      const agent = state.agents.find((candidate) => candidate.id === raw.agentId);
      if (!agent) continue;
      const output: AgentOutput = {
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        content: raw.content || "",
        durationMs: raw.durationMs ?? 0,
        error: raw.error,
      };
      const vote = parseVoteFromOutput(agent.id, agent.name, agent.weight, output.content);
      if (vote) {
        output.vote = vote;
        votes.push(vote);
      }
      outputs.push(output);
    }

    // Preserve votes cast outside this deliberation round (e.g. human votes
    // via the CLI); agent outputs only replace votes from their own agent.
    proposal.votes = mergeVotes(proposal.votes, votes);
    proposal.agentOutputs = outputs;
    const compositeScore = calculateCompositeScore(outputs);
    proposal.compositeScore = compositeScore;
    // Ground the quorum in the configured council (issue #155) and have the
    // APPROVE guard recompute the tally instead of trusting this one (#158).
    const tally = tallyVotes(proposal, state.config, state.agents);
    const synthesisText = synthesize(proposal, state.agents, outputs, tally);
    proposal.synthesis = synthesisText;
    const transition = tally.approved
      ? dispatchProposalEvent(
          proposal,
          { type: "APPROVE", tally },
          { clock: this.dependencies.clock, config: state.config, electorate: state.agents },
        )
      : dispatchProposalEvent(proposal, { type: "REJECT" }, { clock: this.dependencies.clock });
    if (!transition.ok) return transition;

    const audit: AuditEntry = {
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId: proposal.id,
      layer: "intelligence",
      action: tally.approved ? "deliberation_approved" : "deliberation_rejected",
      actor: "system",
      details: `${tally.approved ? "Approved" : "Rejected"}: ${tally.approvalScore}%`,
    };
    state.auditLog.push(audit);
    await this.dependencies.repository.persist();
    return { ok: true, tally, compositeScore, synthesis: synthesisText };
  }
}
