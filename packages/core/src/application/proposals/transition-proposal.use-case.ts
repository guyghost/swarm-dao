import { type DispatchResult, dispatchProposalEvent } from "../../governance/proposal.utils.js";
import type { ProposalEvent } from "../../models/proposal.machine.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";

export type TransitionProposalResult = DispatchResult | { ok: false; error: string };

export class TransitionProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: { proposalId: number; event: ProposalEvent }): Promise<TransitionProposalResult> {
    const proposal = this.dependencies.repository
      .get()
      .proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };

    const result = dispatchProposalEvent(proposal, command.event, { clock: this.dependencies.clock });
    if (result.ok) await this.dependencies.repository.persist();
    return result;
  }
}
