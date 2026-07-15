import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { Proposal } from "../../types/index.js";

export type StartDeliberationResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

export class StartDeliberationUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort; clock: ClockPort }) {}

  public async execute(command: { proposalId: number }): Promise<StartDeliberationResult> {
    const state = this.dependencies.repository.get();
    if (!state.initialized) return { ok: false, error: "DAO not initialized. Run dao_setup first." };
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };
    const transition = dispatchProposalEvent(proposal, { type: "DELIBERATE" }, { clock: this.dependencies.clock });
    if (!transition.ok) return transition;
    state.auditLog.push({
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId: proposal.id,
      layer: "governance",
      action: "deliberation_started",
      actor: "system",
      details: `Deliberation on #${proposal.id}`,
    });
    await this.dependencies.repository.persist();
    return { ok: true, proposal };
  }
}
