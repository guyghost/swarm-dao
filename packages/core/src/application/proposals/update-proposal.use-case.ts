import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { Proposal } from "../../types/index.js";
import { commitMutation } from "../commit-mutation.js";

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
    return commitMutation<UpdateProposalResult>(this.dependencies.repository, async () => {
      const proposal = this.dependencies.repository
        .get()
        .proposals.find((candidate) => candidate.id === command.proposalId);
      if (!proposal) {
        return { persist: false, value: { ok: false as const, error: `Proposal #${command.proposalId} not found.` } };
      }
      if (proposal.status !== "open") {
        return { persist: false, value: { ok: false as const, error: `Must be open (current: ${proposal.status})` } };
      }
      Object.assign(proposal, command.fields);
      return { persist: true, value: { ok: true as const, proposal } };
    });
  }
}
