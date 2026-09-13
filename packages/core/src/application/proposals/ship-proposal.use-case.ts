import { getUnexecutedDependencies } from "../../delivery/dependencies.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { ExecutionWorkspacePort } from "../../ports/workspace.js";
import { ExecuteProposalUseCase } from "./execute-proposal.use-case.js";

export type ShipProposalResult =
  | { ok: true; shipped: number[] }
  // `shipped` reports what was committed before the failure: a cascade is
  // sequential and best-effort (issue #168.5) — earlier ships are NOT rolled
  // back, and the caller can inspect exactly what landed.
  | { ok: false; error: string; shipped: number[] };

export class ShipProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
      /** Optional isolated execution workspace, forwarded to ExecuteProposalUseCase. */
      workspace?: ExecutionWorkspacePort;
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
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.`, shipped: [] };

    const pending: number[] = [];
    // `--force` without `--cascade` skips dependency checks and ships only
    // the target. `--cascade` always resolves the chain — including when
    // combined with `--force` — so force-cascade cannot silently drop deps.
    if (!(command.force && !command.cascade)) {
      const resolution = getUnexecutedDependencies(proposal.id, state.proposals);
      if (resolution.error) return { ok: false, error: resolution.error, shipped: [] };
      pending.push(...(resolution.order ?? []));
      if (pending.length > 0 && !command.cascade) {
        const lines = pending.map((id) => {
          const dependency = state.proposals.find((candidate) => candidate.id === id);
          return dependency ? `- #${dependency.id} [${dependency.status}] ${dependency.title}` : `- #${id} [missing]`;
        });
        return {
          ok: false,
          error: `Cannot ship proposal #${proposal.id}: unexecuted dependencies found.\n\n${lines.join("\n")}\n\nRetry with \`dao_ship proposalId=${proposal.id} cascade=true\` or \`force=true\`.`,
          shipped: [],
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
        return {
          ok: false,
          error: `Cannot cascade ship: dependencies not in 'controlled' state: ${details}`,
          shipped: [],
        };
      }
    }

    const ids = command.cascade ? [...pending, proposal.id] : [proposal.id];
    // Pre-flight (issue #168.5): validate the whole chain is shippable before
    // the first transition, so a mid-cascade failure cannot be caused by a
    // state problem detectable upfront.
    if (ids.length > 1) {
      const notReady = ids.filter((id) => {
        const target = state.proposals.find((candidate) => candidate.id === id);
        return !target || (target.status !== "controlled" && target.status !== "executed");
      });
      if (notReady.length > 0) {
        const details = notReady
          .map((id) => {
            const dependency = state.proposals.find((candidate) => candidate.id === id);
            return dependency ? `#${dependency.id} (${dependency.status})` : `#${id} (missing)`;
          })
          .join(", ");
        return {
          ok: false,
          error: `Cascade pre-flight failed — not all chain members are controlled: ${details}`,
          shipped: [],
        };
      }
    }
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
      if (!result.ok) return { ok: false, error: result.error, shipped };
      shipped.push(id);
    }
    return { ok: true, shipped };
  }
}
