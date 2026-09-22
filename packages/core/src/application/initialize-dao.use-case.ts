import type { DaoStateRepositoryPort } from "../ports/repository.js";
import type { DAOAgent } from "../types/index.js";
import { commitMutation } from "./commit-mutation.js";

export type InitializeDaoResult = { ok: true; agents: DAOAgent[] } | { ok: false; error: string; agents: DAOAgent[] };

export class InitializeDaoUseCase {
  public constructor(private readonly dependencies: { repository: DaoStateRepositoryPort }) {}

  public async execute(command: { agents: DAOAgent[] }): Promise<InitializeDaoResult> {
    return commitMutation<InitializeDaoResult>(this.dependencies.repository, async () => {
      const state = this.dependencies.repository.get();
      if (state.initialized) {
        return {
          persist: false,
          value: {
            ok: false as const,
            error: `DAO already initialized with ${state.agents.length} agents.`,
            agents: state.agents,
          },
        };
      }
      state.agents = command.agents;
      state.initialized = true;
      return { persist: true, value: { ok: true as const, agents: state.agents } };
    });
  }
}
