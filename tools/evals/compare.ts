// ============================================================
// Swarm DAO — Scorecard comparison (pure)
// ============================================================
// Diffs a candidate eval scorecard against a reference. Regressions
// (a gate that passed on the reference but fails on the candidate)
// are the adoption blocker; everything else is informational.

import type { EvalResult, Scorecard } from "./suite.js";

export interface ScorecardDiff {
  /** Gates that passed on the reference and fail on the candidate. */
  readonly regressions: readonly EvalResult[];
  /** Gates that failed on the reference and pass on the candidate. */
  readonly improvements: readonly EvalResult[];
  /** Suite ids present in the candidate but not the reference. */
  readonly added: readonly string[];
  /** Suite ids present in the reference but not the candidate. */
  readonly removed: readonly string[];
  readonly durationDeltaMs: number;
}

export function compareScorecards(base: Scorecard, candidate: Scorecard): ScorecardDiff {
  const baseById = new Map(base.results.map((result) => [result.id, result]));
  const candidateById = new Map(candidate.results.map((result) => [result.id, result]));

  const regressions: EvalResult[] = [];
  const improvements: EvalResult[] = [];
  for (const candidateResult of candidate.results) {
    const baseResult = baseById.get(candidateResult.id);
    if (!baseResult) continue;
    if (baseResult.status === "passed" && candidateResult.status === "failed") {
      regressions.push(candidateResult);
    } else if (baseResult.status === "failed" && candidateResult.status === "passed") {
      improvements.push(candidateResult);
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  for (const id of candidateById.keys()) if (!baseById.has(id)) added.push(id);
  for (const id of baseById.keys()) if (!candidateById.has(id)) removed.push(id);

  return {
    regressions,
    improvements,
    added,
    removed,
    durationDeltaMs: candidate.summary.totalMs - base.summary.totalMs,
  };
}

/** True when the candidate must not be adopted (any regression). */
export function hasRegressions(diff: ScorecardDiff): boolean {
  return diff.regressions.length > 0;
}
