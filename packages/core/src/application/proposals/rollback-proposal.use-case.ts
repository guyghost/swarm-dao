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
    // Honest boundary: this use case performs no git operations and the
    // execution snapshot carries no recoverable commit (commitSha is recorded
    // as "unknown" and filesChanged is never populated), so an automated
    // revert cannot exist. Claiming success here reported a rollback that
    // never happened; surface the manual path instead.
    return {
      ok: false,
      error: `Automated rollback is not supported: the execution snapshot for proposal #${command.proposalId} carries no recoverable commit (branch ${snapshot.branch}). Restore the workspace/branch manually from git history, then correct the proposal state if needed.`,
    };
  }
}
