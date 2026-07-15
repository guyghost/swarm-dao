import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import { calculateCompositeScore } from "../../governance/scoring.js";
import { parseVoteFromOutput, tallyVotes } from "../../governance/voting.js";
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

    proposal.votes = votes;
    proposal.agentOutputs = outputs;
    const compositeScore = calculateCompositeScore(outputs);
    proposal.compositeScore = compositeScore;
    const tally = tallyVotes(proposal, state.config);
    const synthesisText = synthesize(proposal, state.agents, outputs, tally);
    proposal.synthesis = synthesisText;
    const transition = tally.approved
      ? dispatchProposalEvent(proposal, { type: "APPROVE", tally }, { clock: this.dependencies.clock })
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
