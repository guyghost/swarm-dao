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

    const started = dispatchProposalEvent(proposal, { type: "DELIBERATE" }, { clock: this.dependencies.clock });
    if (!started.ok) return started;
    this.audit(state, proposal.id, "governance", "deliberation_started", "system", `Deliberation on #${proposal.id}`);

    const agents = command.agents ?? state.agents;
    let outputs: Awaited<ReturnType<typeof dispatchSwarm>>;
    try {
      // Everything after the DELIBERATE commit is inside the rollback guard:
      // model resolution, swarm dispatch, delegation drain — any throw here
      // would otherwise strand the proposal in `deliberating` (issue #160).
      const modelContext = createDispatchModelContext(state.config.defaultModel, this.dependencies.worker, {
        parentSessionModel: command.parentSessionModel,
        hostDefaultModel: command.hostDefaultModel,
      });
      outputs =
        command.strategy === "sequential"
          ? await dispatchSequentialSwarm(proposal, agents, this.dependencies.worker, modelContext, {
              onUpdate: command.onUpdate,
              charsPerAgent: command.charsPerAgent,
              projectBrief: command.projectBrief,
              runtime: command.runtime,
            })
          : await dispatchSwarm(
              proposal,
              agents,
              this.dependencies.worker,
              state.config.maxConcurrent,
              modelContext,
              command.onUpdate,
              state.config.delegation?.enabled ? { config: state.config, daoRoot: state.daoRoot } : undefined,
              { projectBrief: command.projectBrief, runtime: command.runtime },
            );
    } catch (error) {
      // Rollback (issue #160): without this, a worker/host failure left the
      // proposal stuck in `deliberating` with no recovery path — DELIBERATE is
      // not accepted again from there. ABORT_DELIBERATION returns to `open`
      // so the proposal can be re-deliberated; ERROR would strand it in
      // `failed` with only REJECT as an exit.
      const message = error instanceof Error ? error.message : String(error);
      dispatchProposalEvent(proposal, { type: "ABORT_DELIBERATION" }, { clock: this.dependencies.clock });
      this.audit(state, proposal.id, "intelligence", "deliberation_failed", "system", message);
      await this.dependencies.repository.persist();
      return { ok: false, error: `Deliberation failed: ${message}` };
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
    // Preserve votes cast outside this deliberation round (e.g. human votes
    // via the CLI); agent outputs only replace votes from their own agent.
    proposal.votes = mergeVotes(proposal.votes, votes);
    proposal.agentOutputs = outputs;
    const compositeScore = calculateCompositeScore(outputs);
    proposal.compositeScore = compositeScore;
    // Ground the quorum in the configured council (issue #155) and have the
    // APPROVE guard recompute the tally instead of trusting this one (#158).
    const tally = tallyVotes(proposal, state.config, agents);
    const synthesisText = synthesize(proposal, agents, outputs, tally);
    proposal.synthesis = synthesisText;

    const decision = tally.approved
      ? dispatchProposalEvent(
          proposal,
          { type: "APPROVE", tally },
          { clock: this.dependencies.clock, config: state.config, electorate: agents },
        )
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
