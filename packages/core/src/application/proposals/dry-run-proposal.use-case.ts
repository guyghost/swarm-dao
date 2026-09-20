import { analyzeProposalDryRun } from "../../domain/dry-run.js";
import { isArchivedStatus } from "../../domain/proposal-status.js";
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
    // ADR-004: a closed proposal lives in archive.json. The archive signature
    // only tracks id:status pairs, so a field-level change like dryRunAt is
    // invisible to it — without this flag the write is silently dropped and
    // the mandatory-dry-run gate can never open.
    if (isArchivedStatus(proposal.status)) this.dependencies.repository.markArchivedDirty();
    await this.dependencies.repository.persist();
    return { ok: true, analysis };
  }
}
