import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import { calculateCompositeScore } from "../../governance/scoring.js";
import { parseVoteFromOutput, tallyVotes } from "../../governance/voting.js";
import type { SwarmProgressUpdate } from "../../intelligence/swarm.js";
import { createDispatchModelContext, dispatchSwarm } from "../../intelligence/swarm.js";
import { synthesize } from "../../intelligence/synthesis.js";
import type { ClockPort } from "../../ports/clock.js";
import type { AgentWorkerPort } from "../../ports/host.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AuditEntry, CompositeScore, DAOAgent, TallyResult, Vote } from "../../types/index.js";

export type DeliberateProposalResult =
  | { ok: true; tally: TallyResult; compositeScore: CompositeScore; synthesis: string }
  | { ok: false; error: string };

export class DeliberateProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      worker: AgentWorkerPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: {
    proposalId: number;
    agents?: DAOAgent[];
    parentSessionModel?: string;
    hostDefaultModel?: string;
    onUpdate?: (update: SwarmProgressUpdate) => void;
  }): Promise<DeliberateProposalResult> {
    const state = this.dependencies.repository.get();
    if (!state.initialized) return { ok: false, error: "DAO not initialized. Run dao_setup first." };
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };

    const started = dispatchProposalEvent(proposal, { type: "DELIBERATE" }, { clock: this.dependencies.clock });
    if (!started.ok) return started;
    this.audit(state, proposal.id, "governance", "deliberation_started", "system", `Deliberation on #${proposal.id}`);

    const agents = command.agents ?? state.agents;
    const modelContext = createDispatchModelContext(state.config.defaultModel, this.dependencies.worker, {
      parentSessionModel: command.parentSessionModel,
      hostDefaultModel: command.hostDefaultModel,
    });
    const outputs = await dispatchSwarm(
      proposal,
      agents,
      this.dependencies.worker,
      state.config.maxConcurrent,
      modelContext,
      command.onUpdate,
    );
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const votes = outputs
      .filter((output) => output.content)
      .map((output) =>
        parseVoteFromOutput(
          output.agentId,
          output.agentName,
          agentById.get(output.agentId)?.weight ?? 1,
          output.content,
        ),
      )
      .filter((vote): vote is Vote => vote !== undefined);
    proposal.votes = votes;
    proposal.agentOutputs = outputs;
    const compositeScore = calculateCompositeScore(outputs);
    proposal.compositeScore = compositeScore;
    const tally = tallyVotes(proposal, state.config);
    const synthesisText = synthesize(proposal, agents, outputs, tally);
    proposal.synthesis = synthesisText;

    const decision = tally.approved
      ? dispatchProposalEvent(proposal, { type: "APPROVE", tally }, { clock: this.dependencies.clock })
      : dispatchProposalEvent(proposal, { type: "REJECT" }, { clock: this.dependencies.clock });
    if (!decision.ok) return decision;
    this.audit(
      state,
      proposal.id,
      "intelligence",
      tally.approved ? "deliberation_approved" : "deliberation_rejected",
      "system",
      `${tally.approved ? "Approved" : "Rejected"}: ${tally.approvalScore}%`,
    );
    await this.dependencies.repository.persist();
    return { ok: true, tally, compositeScore, synthesis: synthesisText };
  }

  private audit(
    state: ReturnType<DaoStateRepositoryPort["get"]>,
    proposalId: number,
    layer: AuditEntry["layer"],
    action: string,
    actor: string,
    details: string,
  ): void {
    state.auditLog.push({
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId,
      layer,
      action,
      actor,
      details,
    });
  }
}
