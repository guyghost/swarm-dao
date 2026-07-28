import type { DAOState } from "../types/index.js";

/** Persistence boundary used by application use cases. */
export interface DaoStateRepositoryPort {
  get(): DAOState;
  persist(): Promise<void>;
}
