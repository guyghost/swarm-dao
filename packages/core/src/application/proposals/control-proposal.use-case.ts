import { runGates } from "../../control/gates.js";
import { generateDeliveryPlan } from "../../delivery/plans.js";
import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AuditEntry, ControlCheckResult, DAOState } from "../../types/index.js";

export type ControlProposalResult = { ok: true; control: ControlCheckResult } | { ok: false; error: string };

export class ControlProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: { proposalId: number; failOnGateFailure?: boolean }): Promise<ControlProposalResult> {
    const state = this.dependencies.repository.get();
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };
    if (proposal.status !== "approved") {
      return { ok: false, error: `Must be approved (current: ${proposal.status})` };
    }

    const now = this.dependencies.clock.now();
    const control = runGates(proposal, state.config, { allProposals: state.proposals, now });
    state.controlResults[proposal.id] = control;
    if (control.allGatesPassed) {
      const transition = dispatchProposalEvent(
        proposal,
        { type: "CONTROL_PASS", result: control },
        {
          clock: this.dependencies.clock,
        },
      );
      if (!transition.ok) return transition;
      this.audit(state, proposal.id, "gates_passed", "All gates passed");
      state.deliveryPlans[proposal.id] ??= generateDeliveryPlan(proposal);
    } else {
      if (command.failOnGateFailure) {
        const transition = dispatchProposalEvent(
          proposal,
          { type: "CONTROL_FAIL" },
          { clock: this.dependencies.clock },
        );
        if (!transition.ok) return transition;
      }
      this.audit(state, proposal.id, "gates_failed", `${control.blockerCount} blockers`);
    }
    await this.dependencies.repository.persist();
    return { ok: true, control };
  }

  private audit(state: DAOState, proposalId: number, action: string, details: string): void {
    const entry: AuditEntry = {
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId,
      layer: "control",
      action,
      actor: "system",
      details,
    };
    state.auditLog.push(entry);
  }
}
