import type { DryRunResult, Proposal } from "../types/index.js";
import { PROPOSAL_TYPE } from "../types/index.js";

const DURATION_BY_TYPE: Record<Proposal["type"], string> = {
  [PROPOSAL_TYPE.PRODUCT_FEATURE]: "3-7 days",
  [PROPOSAL_TYPE.SECURITY_CHANGE]: "1-2 weeks",
  [PROPOSAL_TYPE.TECHNICAL_CHANGE]: "2-5 days",
  [PROPOSAL_TYPE.RELEASE_CHANGE]: "1-3 days",
  [PROPOSAL_TYPE.GOVERNANCE_CHANGE]: "1-2 days",
};

export function analyzeProposalDryRun(proposal: Proposal): DryRunResult {
  const filesAffected = [...(proposal.affectedPaths ?? [])];
  const risks: string[] = [];
  if (proposal.type === PROPOSAL_TYPE.SECURITY_CHANGE) risks.push("Security-sensitive changes require extra review");
  if (proposal.riskZone === "red") risks.push("Red-zone proposal: high risk detected");
  if (!proposal.acceptanceCriteria?.length) risks.push("No acceptance criteria defined");
  const estimatedDuration = DURATION_BY_TYPE[proposal.type];
  return {
    proposalId: proposal.id,
    preview: `This proposal would modify ${filesAffected.length || "unknown number of"} files and requires ${estimatedDuration}.`,
    filesAffected,
    risks,
    estimatedDuration,
    canProceed: !risks.some((risk) => risk.includes("high risk") || risk.includes("Security-sensitive")),
  };
}
