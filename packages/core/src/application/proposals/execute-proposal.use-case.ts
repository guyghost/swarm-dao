import { generateDeliveryPlan } from "../../delivery/plans.js";
import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AuditEntry, DeliveryPlan, ExecutionSnapshot, Proposal } from "../../types/index.js";

export type ExecuteProposalResult =
  | { ok: true; proposal: Proposal; plan: DeliveryPlan; snapshot: ExecutionSnapshot }
  | { ok: false; error: string };

export class ExecuteProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: {
    proposalId: number;
    actor: string;
    auditAction?: string;
    auditDetails?: string;
  }): Promise<ExecuteProposalResult> {
    const state = this.dependencies.repository.get();
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };
    if (proposal.status !== "controlled") {
      return { ok: false, error: `Must be controlled (current: ${proposal.status}). Run dao_control first.` };
    }

    const now = this.dependencies.clock.now();
    const plan = state.deliveryPlans[proposal.id] ?? generateDeliveryPlan(proposal, { now });
    state.deliveryPlans[proposal.id] = plan;
    const snapshot: ExecutionSnapshot = {
      proposalId: proposal.id,
      timestamp: now,
      branch: plan.branchStrategy,
      commitSha: "unknown",
      filesChanged: [],
      stateSnapshot: JSON.stringify({ agents: state.agents.length, proposals: state.proposals.length }),
    };
    state.snapshots[proposal.id] = snapshot;

    const transition = dispatchProposalEvent(proposal, { type: "EXECUTE_SUCCESS" }, { clock: this.dependencies.clock });
    if (!transition.ok) return transition;
    proposal.executionResult = `Executed with delivery plan: ${plan.branchStrategy}`;
    const audit: AuditEntry = {
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId: proposal.id,
      layer: "delivery",
      action: command.auditAction ?? "proposal_executed",
      actor: command.actor,
      details: command.auditDetails ?? `Executed #${proposal.id}`,
    };
    state.auditLog.push(audit);
    await this.dependencies.repository.persist();
    return { ok: true, proposal, plan, snapshot };
  }
}
