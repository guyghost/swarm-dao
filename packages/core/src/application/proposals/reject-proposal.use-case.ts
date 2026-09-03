import { dispatchProposalEvent } from "../../governance/proposal.utils.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AuditEntry } from "../../types/index.js";

export type RejectProposalResult =
  | { ok: true; proposalId: number; status: "rejected"; via: "REJECT" | "DISCARD"; message: string }
  | { ok: false; error: string };

/**
 * Human rejection path: an auditable veto/withdrawal of a proposal.
 * The proposal machine decides which event applies (DISCARD from `open`,
 * REJECT from `deliberating`/`approved`); this use case only picks the
 * event from the persisted status and records who rejected, and why.
 */
export class RejectProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: { proposalId: number; actor: string; reason: string }): Promise<RejectProposalResult> {
    const state = this.dependencies.repository.get();
    if (!state.initialized) return { ok: false, error: "DAO not initialized. Run dao_setup first." };
    const proposal = state.proposals.find((candidate) => candidate.id === command.proposalId);
    if (!proposal) return { ok: false, error: `Proposal #${command.proposalId} not found.` };
    if (!command.reason || command.reason.trim().length === 0) {
      return { ok: false, error: "A rejection reason is required (it is recorded in the audit trail)." };
    }

    const event = proposal.status === "open" ? ({ type: "DISCARD" } as const) : ({ type: "REJECT" } as const);
    const dispatched = dispatchProposalEvent(proposal, event, { clock: this.dependencies.clock });
    if (!dispatched.ok) return dispatched;

    const audit: AuditEntry = {
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId: proposal.id,
      layer: "governance",
      action: "proposal_rejected",
      actor: command.actor,
      details: `${event.type}: ${command.reason.trim()}`,
    };
    state.auditLog.push(audit);
    await this.dependencies.repository.persist();
    return {
      ok: true,
      proposalId: proposal.id,
      status: "rejected",
      via: event.type,
      message: `Proposal #${proposal.id} rejected via ${event.type} by ${command.actor}.`,
    };
  }
}
