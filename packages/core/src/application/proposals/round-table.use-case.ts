import type { RoundTableSuggestion } from "../../intelligence/roundtable.js";
import { runRoundTable } from "../../intelligence/roundtable.js";
import { createDispatchModelContext } from "../../intelligence/swarm.js";
import type { ClockPort } from "../../ports/clock.js";
import type { AgentWorkerPort } from "../../ports/host.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { DAOAgent } from "../../types/index.js";
import { CreateProposalUseCase } from "./create-proposal.use-case.js";

export type RoundTableResult =
  | { ok: true; suggestions: RoundTableSuggestion[]; proposalIds: Map<string, number> }
  | { ok: false; error: string };

export class RoundTableUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      worker: AgentWorkerPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: {
    agents?: DAOAgent[];
    parentSessionModel?: string;
    hostDefaultModel?: string;
  }): Promise<RoundTableResult> {
    const state = this.dependencies.repository.get();
    if (!state.initialized) return { ok: false, error: "DAO not initialized. Run dao_setup first." };
    const agents = command.agents ?? state.agents;
    const modelContext = createDispatchModelContext(state.config.defaultModel, this.dependencies.worker, {
      parentSessionModel: command.parentSessionModel,
      hostDefaultModel: command.hostDefaultModel,
    });
    const suggestions = await runRoundTable(
      this.dependencies.worker,
      agents,
      state.config.maxConcurrent,
      modelContext,
      this.dependencies.clock,
    );
    const proposalIds = new Map<string, number>();
    const stagedRepository: DaoStateRepositoryPort = {
      get: () => state,
      persist: async () => undefined,
    };
    const createProposal = new CreateProposalUseCase({
      repository: stagedRepository,
      clock: this.dependencies.clock,
    });
    for (const suggestion of suggestions) {
      if (!suggestion.parsed) continue;
      const created = await createProposal.execute({
        ...suggestion.parsed,
        proposedBy: suggestion.agentId,
      });
      if (!created.ok) {
        suggestion.error = `Failed to create proposal: ${created.error}`;
        continue;
      }
      suggestion.proposalId = created.proposal.id;
      proposalIds.set(suggestion.agentId, created.proposal.id);
      state.auditLog.push({
        id: state.nextAuditId++,
        timestamp: this.dependencies.clock.now(),
        proposalId: created.proposal.id,
        layer: "intelligence",
        action: "roundtable_proposal_created",
        actor: suggestion.agentId,
        details: "Auto-created from round table",
      });
    }
    await this.dependencies.repository.persist();
    return { ok: true, suggestions, proposalIds };
  }
}
