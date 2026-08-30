import { generateDeliveryPlan } from "../../delivery/plans.js";
import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { ExecutionWorkspacePort } from "../../ports/workspace.js";
import type { AuditEntry, DeliveryPlan, ExecutionSnapshot, Proposal } from "../../types/index.js";

export type ExecuteProposalResult =
  | { ok: true; proposal: Proposal; plan: DeliveryPlan; snapshot: ExecutionSnapshot }
  | { ok: false; error: string };

/** Caller-supplied detail is preserved; isolation facts are appended, never dropped. */
function auditDetails(
  command: { auditDetails?: string },
  proposalId: number,
  executionBranch: string | undefined,
  workspacePath: string | null | undefined,
): string {
  if (!workspacePath || !executionBranch) {
    return command.auditDetails ?? `Executed #${proposalId}`;
  }
  const isolation = `isolated execution on ${executionBranch} (${workspacePath})`;
  return command.auditDetails ? `${command.auditDetails} — ${isolation}` : `Executed #${proposalId} — ${isolation}`;
}

export class ExecuteProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
      /** Optional isolated execution workspace (e.g. git worktree). */
      workspace?: ExecutionWorkspacePort;
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

    // Provision the isolated workspace (if configured) BEFORE any state
    // transition: a failed preparation must leave the proposal controlled.
    let executionBranch: string | undefined;
    let workspacePath: string | null | undefined;
    if (this.dependencies.workspace) {
      const prepared = await this.dependencies.workspace.prepare(proposal);
      if (!prepared.ok) {
        return { ok: false, error: `Execution workspace preparation failed: ${prepared.error}` };
      }
      executionBranch = prepared.branch;
      workspacePath = prepared.path;
    }

    const snapshot: ExecutionSnapshot = {
      proposalId: proposal.id,
      timestamp: now,
      branch: executionBranch ?? plan.branchStrategy,
      commitSha: "unknown",
      filesChanged: [],
      stateSnapshot: JSON.stringify({ agents: state.agents.length, proposals: state.proposals.length }),
    };
    state.snapshots[proposal.id] = snapshot;

    const transition = dispatchProposalEvent(proposal, { type: "EXECUTE_SUCCESS" }, { clock: this.dependencies.clock });
    if (!transition.ok) return transition;
    proposal.executionResult = `Executed with delivery plan: ${executionBranch ?? plan.branchStrategy}`;
    const audit: AuditEntry = {
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId: proposal.id,
      layer: "delivery",
      action: command.auditAction ?? "proposal_executed",
      actor: command.actor,
      details: auditDetails(command, proposal.id, executionBranch, workspacePath),
    };
    state.auditLog.push(audit);
    await this.dependencies.repository.persist();
    return { ok: true, proposal, plan, snapshot };
  }
}
