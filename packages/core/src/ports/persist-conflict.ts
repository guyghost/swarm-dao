/**
 * A persist() refused to commit because another writer owns the DAO files,
 * or because this process lost the lock before its commit point.
 *
 * `retryable` is true only when this attempt wrote nothing. A conflict after
 * a partial commit must not be replayed blindly — the caller reopens and
 * decides. Use cases replay a retryable conflict by reloading and reapplying
 * the command.
 */
export class PersistConflictError extends Error {
  readonly retryable: boolean;

  public constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "PersistConflictError";
    this.retryable = retryable;
  }
}
