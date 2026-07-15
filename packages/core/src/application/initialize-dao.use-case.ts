import type { DaoStateRepositoryPort } from "../ports/repository.js";
import type { DAOAgent } from "../types/index.js";

export type InitializeDaoResult = { ok: true; agents: DAOAgent[] } | { ok: false; error: string; agents: DAOAgent[] };

export class InitializeDaoUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort }) {}

  public async execute(command: { agents: DAOAgent[] }): Promise<InitializeDaoResult> {
    const state = this.dependencies.repository.get();
    if (state.initialized) {
      return { ok: false, error: `DAO already initialized with ${state.agents.length} agents.`, agents: state.agents };
    }
    state.agents = command.agents;
    state.initialized = true;
    await this.dependencies.repository.persist();
    return { ok: true, agents: state.agents };
  }
}
