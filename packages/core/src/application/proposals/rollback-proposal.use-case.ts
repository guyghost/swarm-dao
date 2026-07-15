import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { ExecutionSnapshot } from "../../types/index.js";

export type RollbackProposalResult =
  | { ok: true; snapshot: ExecutionSnapshot; message: string }
  | { ok: false; error: string };

export class RollbackProposalUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort }) {}

  public async execute(command: { proposalId: number }): Promise<RollbackProposalResult> {
    const snapshot = this.dependencies.repository.get().snapshots[command.proposalId];
    if (!snapshot) return { ok: false, error: `No snapshot found for proposal #${command.proposalId}` };
    return {
      ok: true,
      snapshot,
      message: `Proposal #${command.proposalId} rolled back to commit ${snapshot.commitSha.slice(0, 8)} on branch ${snapshot.branch}`,
    };
  }
}
