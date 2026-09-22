import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { Proposal } from "../../types/index.js";
import { commitMutation } from "../commit-mutation.js";

export type StartDeliberationResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

export class StartDeliberationUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort; clock: ClockPort }) {}

  public async execute(command: { proposalId: number }): Promise<StartDeliberationResult> {
    return commitMutation<StartDeliberationResult>(this.dependencies.repository, async () => {
      const state = this.dependencies.repository.get();
      if (!state.initialized) {
        return { persist: false, value: { ok: false as const, error: "DAO not initialized. Run dao_setup first." } };
      }
      const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
      if (!proposal) {
        return { persist: false, value: { ok: false as const, error: `Proposal #${command.proposalId} not found.` } };
      }
      const transition = dispatchProposalEvent(proposal, { type: "DELIBERATE" }, { clock: this.dependencies.clock });
      if (!transition.ok) return { persist: false, value: transition };
      state.auditLog.push({
        id: state.nextAuditId++,
        timestamp: this.dependencies.clock.now(),
        proposalId: proposal.id,
        layer: "governance",
        action: "deliberation_started",
        actor: "system",
        details: `Deliberation on #${proposal.id}`,
      });
      return { persist: true, value: { ok: true as const, proposal } };
    });
  }
}
