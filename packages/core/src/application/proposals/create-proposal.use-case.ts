import { classifyRiskZone } from "../../governance/lifecycle.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { Proposal, ProposalType } from "../../types/index.js";

export interface CreateProposalCommand {
  title: string;
  type: ProposalType;
  description: string;
  proposedBy: string;
  context?: string;
  problemStatement?: string;
  acceptanceCriteria?: string[];
  successMetrics?: string[];
  rollbackConditions?: string[];
  affectedPaths?: string[];
  dependsOn?: number[];
  auditAction?: string;
  auditDetails?: string;
}

export type CreateProposalResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

export class CreateProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: CreateProposalCommand): Promise<CreateProposalResult> {
    const state = this.dependencies.repository.get();
    if (!state.initialized) {
      return { ok: false, error: "DAO not initialized. Run dao_setup first." };
    }
    const missingDependency = command.dependsOn?.find(
      (dependencyId) => !state.proposals.some((proposal) => proposal.id === dependencyId),
    );
    if (missingDependency !== undefined) {
      return { ok: false, error: `Unknown proposal dependency #${missingDependency}.` };
    }

    const proposal: Proposal = {
      id: state.nextProposalId++,
      title: command.title,
      type: command.type,
      description: command.description,
      context: command.context,
      problemStatement: command.problemStatement,
      acceptanceCriteria: command.acceptanceCriteria,
      successMetrics: command.successMetrics,
      rollbackConditions: command.rollbackConditions,
      affectedPaths: command.affectedPaths,
      dependsOn: command.dependsOn,
      proposedBy: command.proposedBy,
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: this.dependencies.clock.now(),
    };
    proposal.riskZone = classifyRiskZone(proposal);
    state.proposals.push(proposal);
    state.auditLog.push({
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId: proposal.id,
      layer: "governance",
      action: command.auditAction ?? "proposal_created",
      actor: command.proposedBy,
      details: command.auditDetails ?? `Proposal "${command.title}" created`,
    });
    await this.dependencies.repository.persist();
    return { ok: true, proposal };
  }
}
