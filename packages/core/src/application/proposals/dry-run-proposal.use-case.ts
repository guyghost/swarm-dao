import { analyzeProposalDryRun } from "../../domain/dry-run.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { DryRunResult } from "../../types/index.js";

export type DryRunProposalResult = { ok: true; analysis: DryRunResult } | { ok: false; error: string };

export class DryRunProposalUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort; clock: ClockPort }) {}

  public async execute(command: { proposalId: number }): Promise<DryRunProposalResult> {
    const proposal = this.dependencies.repository
      .get()
      .proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };
    const analysis = analyzeProposalDryRun(proposal);
    proposal.dryRunAt = this.dependencies.clock.now();
    proposal.dryRunCanProceed = analysis.canProceed;
    await this.dependencies.repository.persist();
    return { ok: true, analysis };
  }
}
