import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { DAOState } from "../../types/index.js";

/** Fast isolated repository for pure application tests and embedded hosts. */
export class InMemoryDaoStateRepository implements DaoStateRepositoryPort {
  public constructor(private readonly state: DAOState) {}

  public get(): DAOState {
    return this.state;
  }

  public async persist(): Promise<void> {
    // State already lives in this isolated instance.
  }
}
