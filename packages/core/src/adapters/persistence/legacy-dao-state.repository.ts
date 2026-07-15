import { getState, saveState } from "../../persistence.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { DAOState } from "../../types/index.js";

/**
 * Compatibility adapter for hosts not yet migrated to repository instances.
 * New hosts should own an isolated repository and inject it into use cases.
 */
export class LegacyDaoStateRepository implements DaoStateRepositoryPort {
  public get(): DAOState {
    return getState();
  }

  public persist(): Promise<void> {
    return saveState();
  }
}
