import { PersistConflictError } from "../ports/persist-conflict.js";
import type { DaoStateRepositoryPort } from "../ports/repository.js";

/** Bounded reopen-and-reapply attempts for a retryable persist conflict. */
const MAX_ATTEMPTS = 3;

export interface MutationOutcome<T> {
  /** When false, the outcome is returned as-is and nothing is written. */
  persist: boolean;
  value: T;
}

/**
 * Run `mutate` against the current repository state and persist it.
 * On a retryable conflict that wrote nothing, reload the repository (discarding
 * the failed attempt's memory) and run `mutate` again. External work that must
 * not be repeated — a swarm dispatch, a round table — stays outside `mutate`
 * and is closed over.
 */
export async function commitMutation<T>(
  repository: DaoStateRepositoryPort,
  mutate: () => Promise<MutationOutcome<T>>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      if (!repository.reload) throw lastError;
      await repository.reload();
    }
    const outcome = await mutate();
    if (!outcome.persist) return outcome.value;
    try {
      await repository.persist();
      return outcome.value;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof PersistConflictError && error.retryable && attempt < MAX_ATTEMPTS;
      if (!retryable) throw error;
    }
  }
  throw lastError;
}
