import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { OutcomeRating } from "../../types/index.js";
import { commitMutation } from "../commit-mutation.js";

export type RateProposalResult = { ok: true; rating: OutcomeRating } | { ok: false; error: string };

export class RateProposalUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort; clock: ClockPort }) {}

  public async execute(command: {
    proposalId: number;
    rater: string;
    score: 1 | 2 | 3 | 4 | 5;
    comment: string;
  }): Promise<RateProposalResult> {
    return commitMutation<RateProposalResult>(this.dependencies.repository, async () => {
      const state = this.dependencies.repository.get();
      const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
      if (!proposal)
        return { persist: false, value: { ok: false as const, error: `Proposal #${command.proposalId} not found.` } };
      if (proposal.status !== "executed") {
        return {
          persist: false,
          value: { ok: false as const, error: `Proposal #${proposal.id} is ${proposal.status}, must be executed.` },
        };
      }
      const now = this.dependencies.clock.now();
      const rating: OutcomeRating = { ...command, ratedAt: now };
      const outcome = state.outcomes[proposal.id] ?? {
        proposalId: proposal.id,
        ratings: [],
        metrics: [],
        overallScore: 0,
        status: "pending" as const,
        createdAt: now,
        updatedAt: now,
      };
      outcome.ratings.push(rating);
      outcome.overallScore = outcome.ratings.reduce((sum, item) => sum + item.score, 0) / outcome.ratings.length;
      outcome.updatedAt = now;
      state.outcomes[proposal.id] = outcome;
      // Re-rating replaces an existing outcome value behind the archive's
      // structural signature (ADR-004 mutation contract).
      this.dependencies.repository.markArchivedDirty();
      return { persist: true, value: { ok: true as const, rating } };
    });
  }
}
