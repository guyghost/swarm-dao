import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import { calculateCompositeScore } from "../../governance/scoring.js";
import { mergeVotes, parseVoteFromOutput, tallyVotes } from "../../governance/voting.js";
import { synthesize } from "../../intelligence/synthesis.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AgentOutput, AuditEntry, Vote } from "../../types/index.js";
import { commitMutation } from "../commit-mutation.js";
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
    return commitMutation<DeliberateProposalResult>(this.dependencies.repository, async () => {
      const state = this.dependencies.repository.get();
      const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
      if (!proposal) {
        return { persist: false, value: { ok: false as const, error: `Proposal #${command.proposalId} not found.` } };
      }
      if (proposal.status !== "deliberating") {
        return {
          persist: false,
          value: { ok: false as const, error: `Expected deliberating (current: ${proposal.status})` },
        };
      }

      if (command.outputs.length === 0) {
        return { persist: false, value: { ok: false as const, error: "No agent outputs provided." } };
      }
      const unknownIds = [
        ...new Set(
          command.outputs.map((raw) => raw.agentId).filter((id) => !state.agents.some((agent) => agent.id === id)),
        ),
      ];
      if (unknownIds.length > 0) {
        return {
          persist: false,
          value: {
            ok: false as const,
            error: `Unknown agent id(s): ${unknownIds.join(", ")}. Outputs were not recorded.`,
          },
        };
      }
      const counts = new Map<string, number>();
      for (const raw of command.outputs) counts.set(raw.agentId, (counts.get(raw.agentId) ?? 0) + 1);
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
      if (duplicates.length > 0) {
        return {
          persist: false,
          value: {
            ok: false as const,
            error: `Duplicate agent output(s): ${duplicates.join(", ")}. Outputs were not recorded.`,
          },
        };
      }
      const missing = state.agents.map((agent) => agent.id).filter((id) => !counts.has(id));
      if (missing.length > 0) {
        return {
          persist: false,
          value: {
            ok: false as const,
            error: `Incomplete deliberation: missing agent output(s): ${missing.join(", ")}. Outputs were not recorded.`,
          },
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
      if (!transition.ok) return { persist: false, value: transition };

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
      return { persist: true, value: { ok: true as const, tally, compositeScore, synthesis: synthesisText } };
    });
  }
}
