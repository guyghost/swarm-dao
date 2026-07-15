import type { InitializeDaoResult } from "../application/initialize-dao.use-case.js";
import type { CreateAmendmentProposalResult } from "../application/proposals/create-amendment-proposal.use-case.js";
import type { DeliberateProposalResult } from "../application/proposals/deliberate-proposal.use-case.js";
import type { ExecuteProposalResult } from "../application/proposals/execute-proposal.use-case.js";
import type { RollbackProposalResult } from "../application/proposals/rollback-proposal.use-case.js";
import type { ShipProposalResult } from "../application/proposals/ship-proposal.use-case.js";
import { formatControlResult } from "../control/gates.js";
import { formatDryRun } from "../delivery/dry-run.js";
import { formatAgentsTable } from "../governance/agents.js";
import { formatCompositeScore } from "../governance/scoring.js";
import { formatTallyResult } from "../governance/voting.js";
import type { ControlCheckResult, DryRunResult, OutcomeRating, Proposal } from "../types/index.js";
import { PROPOSAL_TYPE_LABELS } from "../types/index.js";

export function presentProposalCreated(proposal: Proposal): string {
  const typeLabel = PROPOSAL_TYPE_LABELS[proposal.type] ?? proposal.type;
  return `# 📋 Proposal Created — #${proposal.id}\n\n**Title:** ${proposal.title}\n**Type:** ${proposal.type} — ${typeLabel}\n**Zone:** ${proposal.riskZone}\n\nRun \`dao_deliberate proposalId=${proposal.id}\``;
}

export function presentInitialization(result: InitializeDaoResult): string {
  if (!result.ok) return result.error;
  return `# DAO Initialized\n\n${formatAgentsTable(result.agents)}\n\nRun \`dao_help\` to discover the workflow, then \`dao_propose\` to create proposals.`;
}

export function presentDeliberation(
  proposalId: number,
  result: Extract<DeliberateProposalResult, { ok: true }>,
  options: { durationMs?: number; controlToolName: string },
): string {
  const duration = options.durationMs === undefined ? "" : ` (${options.durationMs}ms)`;
  return `# 🗳️ Deliberation Complete — #${proposalId}${duration}\n\n${formatTallyResult(result.tally)}\n\n${formatCompositeScore(result.compositeScore)}\n\n${result.synthesis}\n\n> Next: \`${options.controlToolName} proposalId=${proposalId}\``;
}

export function presentControl(control: ControlCheckResult): string {
  return formatControlResult(control);
}

export function presentExecution(result: Extract<ExecuteProposalResult, { ok: true }>): string {
  const taskCount = result.plan.phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  return `# ✅ Proposal Executed — #${result.proposal.id}\n\n**Title:** ${result.proposal.title}\n**Status:** 🚀 executed\n**Branch:** \`${result.plan.branchStrategy}\`\n**Plan:** ${result.plan.phases.length} phases, ${taskCount} tasks\n\nThe delivery agent has prepared an implementation plan. Review the tasks and begin implementation.`;
}

export function presentShip(result: Extract<ShipProposalResult, { ok: true }>): string {
  return `# 🚀 Ship Complete\n\nShipped proposals:\n${result.shipped.map((id) => `- #${id}`).join("\n")}`;
}

export function presentAmendment(result: Extract<CreateAmendmentProposalResult, { ok: true }>): string {
  return `# 📜 Amendment Proposed — #${result.proposal.id}\n\nType: ${result.payload.type}\n\nRun \`dao_deliberate proposalId=${result.proposal.id}\``;
}

export function presentDryRun(result: DryRunResult): string {
  return formatDryRun(result);
}

export function presentRating(rating: OutcomeRating): string {
  return `# ⭐ Rating Recorded — #${rating.proposalId}\n\n**Score:** ${rating.score}/5\n**Comment:** ${rating.comment}`;
}

export function presentProposalUpdated(proposal: Proposal): string {
  return `# 📝 Proposal Updated — #${proposal.id}\n\nUpdated fields applied.`;
}

export function presentRollback(result: RollbackProposalResult): string {
  return result.ok ? `# ⏪ Rollback Successful\n\n${result.message}` : `# ❌ Rollback Failed\n\n${result.error}`;
}
