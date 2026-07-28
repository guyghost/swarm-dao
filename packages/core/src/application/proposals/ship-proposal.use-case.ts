import { getUnexecutedDependencies } from "../../delivery/dependencies.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import { ExecuteProposalUseCase } from "./execute-proposal.use-case.js";

export type ShipProposalResult = { ok: true; shipped: number[] } | { ok: false; error: string };

export class ShipProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: {
    proposalId: number;
    actor: string;
    cascade?: boolean;
    force?: boolean;
  }): Promise<ShipProposalResult> {
    const state = this.dependencies.repository.get();
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };

    const pending: number[] = [];
    if (!command.force) {
      const resolution = getUnexecutedDependencies(proposal.id, state.proposals);
      if (resolution.error) return { ok: false, error: resolution.error };
      pending.push(...(resolution.order ?? []));
      if (pending.length > 0 && !command.cascade) {
        const lines = pending.map((id) => {
          const dependency = state.proposals.find((candidate) => candidate.id === id);
          return dependency ? `- #${dependency.id} [${dependency.status}] ${dependency.title}` : `- #${id} [missing]`;
        });
        return {
          ok: false,
          error: `Cannot ship proposal #${proposal.id}: unexecuted dependencies found.\n\n${lines.join("\n")}\n\nRetry with \`dao_ship proposalId=${proposal.id} cascade=true\` or \`force=true\`.`,
        };
      }
      const notControlled = pending.filter(
        (id) => state.proposals.find((candidate) => candidate.id === id)?.status !== "controlled",
      );
      if (command.cascade && notControlled.length > 0) {
        const details = notControlled
          .map((id) => {
            const dependency = state.proposals.find((candidate) => candidate.id === id);
            return dependency ? `#${dependency.id} (${dependency.status})` : `#${id} (missing)`;
          })
          .join(", ");
        return { ok: false, error: `Cannot cascade ship: dependencies not in 'controlled' state: ${details}` };
      }
    }

    const ids = command.cascade ? [...pending, proposal.id] : [proposal.id];
    const shipped: number[] = [];
    const executor = new ExecuteProposalUseCase(this.dependencies);
    for (const id of ids) {
      const target = state.proposals.find((candidate) => candidate.id === id);
      if (target?.status === "executed") continue;
      const result = await executor.execute({
        proposalId: id,
        actor: command.actor,
        auditAction: "proposal-shipped",
        auditDetails: "shipped via dao_ship",
      });
      if (!result.ok) return result;
      shipped.push(id);
    }
    return { ok: true, shipped };
  }
}
