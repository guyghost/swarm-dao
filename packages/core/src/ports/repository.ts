import type { DAOState } from "../types/index.js";

/** Persistence boundary used by application use cases. */
export interface DaoStateRepositoryPort {
  get(): DAOState;
  persist(): Promise<void>;
  /** ADR-004 mutation contract: call after mutating values inside archived
   *  (closed-proposal) data — e.g. re-rating an existing outcome, replacing an
   *  artefact of a closed proposal. The repository's no-op detection cannot
   *  see in-place value edits behind the archive's structural signature;
   *  this flag forces the archive to be re-serialized on the next persist().
   *  Structural changes (closures, new satellite entries, status transitions)
   *  are detected automatically and do not require this call. No-op on
   *  repositories that do not partition (in-memory, legacy). */
  markArchivedDirty(): void;
}
