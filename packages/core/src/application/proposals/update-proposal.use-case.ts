import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { Proposal } from "../../types/index.js";

export interface UpdateProposalFields {
  problemStatement?: string;
  acceptanceCriteria?: string[];
  successMetrics?: string[];
  rollbackConditions?: string[];
}

export type UpdateProposalResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

export class UpdateProposalUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort }) {}

  public async execute(command: { proposalId: number; fields: UpdateProposalFields }): Promise<UpdateProposalResult> {
    const proposal = this.dependencies.repository
      .get()
      .proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };
    if (proposal.status !== "open") return { ok: false, error: `Must be open (current: ${proposal.status})` };
    Object.assign(proposal, command.fields);
    await this.dependencies.repository.persist();
    return { ok: true, proposal };
  }
}
