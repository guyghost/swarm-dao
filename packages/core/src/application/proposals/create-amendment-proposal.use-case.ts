import { validateAmendmentPayload } from "../../governance/amendments.js";
import type { ClockPort } from "../../ports/clock.js";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import type { AmendmentPayload, AuditEntry, Proposal } from "../../types/index.js";
import { CreateProposalUseCase } from "./create-proposal.use-case.js";

export type CreateAmendmentProposalResult =
  | { ok: true; proposal: Proposal; payload: AmendmentPayload }
  | { ok: false; error: string };

export class CreateAmendmentProposalUseCase {
  public constructor(
    private readonly dependencies: {
      repository: DaoStateRepositoryPort;
      clock: ClockPort;
    },
  ) {}

  public async execute(command: {
    title: string;
    description: string;
    payload: AmendmentPayload;
    proposedBy: string;
  }): Promise<CreateAmendmentProposalResult> {
    const validation = validateAmendmentPayload(command.payload);
    if (!validation.valid) return { ok: false, error: `Validation failed:\n${validation.errors.join("\n")}` };

    const created = await new CreateProposalUseCase(this.dependencies).execute({
      title: command.title,
      type: "governance-change",
      description: command.description,
      proposedBy: command.proposedBy,
    });
    if (!created.ok) return created;
    const proposal = created.proposal;
    proposal.amendmentPayload = command.payload;
    proposal.amendmentOrigin = { source: "human" };
    proposal.amendmentState = "pending-vote";
    const state = this.dependencies.repository.get();
    const audit: AuditEntry = {
      id: state.nextAuditId++,
      timestamp: this.dependencies.clock.now(),
      proposalId: proposal.id,
      layer: "governance",
      action: "amendment_proposed",
      actor: command.proposedBy,
      details: `Amendment: ${command.payload.type}`,
    };
    state.auditLog.push(audit);
    await this.dependencies.repository.persist();
    return { ok: true, proposal, payload: command.payload };
  }
}
