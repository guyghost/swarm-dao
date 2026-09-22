import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import { calculateCompositeScore } from "../../governance/scoring.js";
import { mergeVotes, parseVoteFromOutput, tallyVotes } from "../../governance/voting.js";
import type { RuntimeResolutionContext } from "../../intelligence/runtime.js";
import { dispatchSequentialSwarm } from "../../intelligence/sequential.js";
import type { SwarmProgressUpdate } from "../../intelligence/swarm.js";
import { createDispatchModelContext, dispatchSwarm } from "../../intelligence/swarm.js";
import { synthesize } from "../../intelligence/synthesis.js";
import type { ClockPort } from "../../ports/clock.js";
import type { AgentWorkerPort } from "../../ports/host.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AuditEntry, CompositeScore, DAOAgent, TallyResult, Vote } from "../../types/index.js";
import { commitMutation } from "../commit-mutation.js";

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
    /** Deliberation orchestration; defaults to the parallel swarm. */
    strategy?: "parallel" | "sequential";
    /** Sequential only: analysis characters forwarded per prior agent. */
    charsPerAgent?: number;
    /** Shared project brief injected into every participant's prompt. */
    projectBrief?: string;
    /** Runtime resolution context (models/agent-runtime.md): harness
     * defaults, per-harness model flags. */
    runtime?: RuntimeResolutionContext;
  }): Promise<DeliberateProposalResult> {
    const state = this.dependencies.repository.get();
    if (!state.initialized) return { ok: false, error: "DAO not initialized. Run dao_setup first." };
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };

    const agents = command.agents ?? state.agents;
    const canStart = proposal.status === "open";
    // Copy so a worker cannot mutate the live proposal before the commit,
    // which a persist conflict would otherwise replay twice.
    const promptProposal = { ...proposal, votes: [...proposal.votes], agentOutputs: [...proposal.agentOutputs] };
    let outputs: Awaited<ReturnType<typeof dispatchSwarm>> | undefined;
    let swarmError: string | undefined;
    if (canStart) {
      try {
        const modelContext = createDispatchModelContext(this.dependencies.worker, {
          parentSessionModel: command.parentSessionModel,
          hostDefaultModel: command.hostDefaultModel,
        });
        outputs =
          command.strategy === "sequential"
            ? await dispatchSequentialSwarm(promptProposal, agents, this.dependencies.worker, modelContext, {
                onUpdate: command.onUpdate,
                charsPerAgent: command.charsPerAgent,
                projectBrief: command.projectBrief,
                runtime: command.runtime,
              })
            : await dispatchSwarm(
                promptProposal,
                agents,
                this.dependencies.worker,
                state.config.maxConcurrent,
                modelContext,
                command.onUpdate,
                state.config.delegation?.enabled ? { config: state.config, daoRoot: state.daoRoot } : undefined,
                { projectBrief: command.projectBrief, runtime: command.runtime },
              );
      } catch (error) {
        swarmError = error instanceof Error ? error.message : String(error);
      }
    }

    return commitMutation<DeliberateProposalResult>(this.dependencies.repository, async () => {
      const current = this.dependencies.repository.get();
      const target = current.proposals.find((candidate) => candidate.id === command.proposalId);
      if (!target) {
        return { persist: false, value: { ok: false as const, error: `Proposal #${command.proposalId} not found.` } };
      }
      const started = dispatchProposalEvent(target, { type: "DELIBERATE" }, { clock: this.dependencies.clock });
      if (!started.ok) return { persist: false, value: started };
      this.audit(current, target.id, "governance", "deliberation_started", "system", `Deliberation on #${target.id}`);
      if (swarmError || !outputs) {
        // Issue #160: a worker failure must not leave the proposal deliberating.
        const message = swarmError ?? "Deliberation produced no outputs.";
        dispatchProposalEvent(target, { type: "ABORT_DELIBERATION" }, { clock: this.dependencies.clock });
        this.audit(current, target.id, "intelligence", "deliberation_failed", "system", message);
        return { persist: true, value: { ok: false as const, error: `Deliberation failed: ${message}` } };
      }
      const agentById = new Map(agents.map((agent) => [agent.id, agent]));
      const votes: Vote[] = [];
      for (const output of outputs) {
        if (!output.content) continue;
        const vote = parseVoteFromOutput(
          output.agentId,
          output.agentName,
          agentById.get(output.agentId)?.weight ?? 1,
          output.content,
        );
        if (vote) {
          output.vote = vote;
          votes.push(vote);
        }
      }
      target.votes = mergeVotes(target.votes, votes);
      target.agentOutputs = outputs;
      const compositeScore = calculateCompositeScore(outputs);
      target.compositeScore = compositeScore;
      const tally = tallyVotes(target, current.config, agents);
      const synthesisText = synthesize(target, agents, outputs, tally);
      target.synthesis = synthesisText;
      const decision = tally.approved
        ? dispatchProposalEvent(
            target,
            { type: "APPROVE", tally },
            { clock: this.dependencies.clock, config: current.config, electorate: agents },
          )
        : dispatchProposalEvent(target, { type: "REJECT" }, { clock: this.dependencies.clock });
      if (!decision.ok) return { persist: false, value: decision };
      this.audit(
        current,
        target.id,
        "intelligence",
        tally.approved ? "deliberation_approved" : "deliberation_rejected",
        "system",
        `${tally.approved ? "Approved" : "Rejected"}: ${tally.approvalScore}%`,
      );
      return { persist: true, value: { ok: true as const, tally, compositeScore, synthesis: synthesisText } };
    });
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
