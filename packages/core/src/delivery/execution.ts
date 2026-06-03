// ============================================================
// Swarm DAO Core — Proposal Execution
// ============================================================

import { transitionProposal } from "../governance/lifecycle.js";
import { captureSnapshot, getState, storeVerification } from "../persistence.js";
import type { ExecutionSnapshot, ExecutionVerification, Proposal, VerificationStatus } from "../types/index.js";
import { generateDeliveryPlan } from "./plans.js";

export interface ExecutionResult {
  success: boolean;
  result: string;
  filesChanged?: string[];
}

export interface ProposalQualityValidation {
  valid: boolean;
  missing: string[];
}

export function validateProposalQuality(proposal: Proposal): ProposalQualityValidation {
  const missing: string[] = [];

  if (!proposal.problemStatement || proposal.problemStatement.trim().length < 20) {
    missing.push("problemStatement");
  }
  if (!Array.isArray(proposal.acceptanceCriteria) || proposal.acceptanceCriteria.length === 0) {
    missing.push("acceptanceCriteria");
  }
  if (!Array.isArray(proposal.successMetrics) || proposal.successMetrics.length === 0) {
    missing.push("successMetrics");
  }

  return { valid: missing.length === 0, missing };
}

export async function executeProposal(proposal: Proposal): Promise<ExecutionResult> {
  const state = getState();

  // Generate or retrieve delivery plan
  let plan = state.deliveryPlans[proposal.id];
  if (!plan) {
    plan = generateDeliveryPlan(proposal);
    state.deliveryPlans[proposal.id] = plan;
  }

  // Capture snapshot (conceptual — actual file snapshot done by adapter)
  const snapshot: ExecutionSnapshot = {
    proposalId: proposal.id,
    timestamp: new Date().toISOString(),
    branch: plan.branchStrategy,
    commitSha: "unknown",
    filesChanged: [],
    stateSnapshot: JSON.stringify({
      agents: state.agents.length,
      proposals: state.proposals?.length ?? 0,
    }),
  };
  await captureSnapshot(proposal.id, snapshot);

  // Advance state machine: controlled → executed
  const transition = transitionProposal(proposal, "execute");
  if (!transition.success) {
    return { success: false, result: transition.error ?? `Cannot execute proposal from status "${proposal.status}"` };
  }
  proposal.executionResult = `Executed with delivery plan: ${plan.branchStrategy}`;

  return {
    success: true,
    result: `# ✅ Proposal Executed — #${proposal.id}

**Title:** ${proposal.title}
**Status:** 🚀 executed
**Branch:** \`${plan.branchStrategy}\`
**Plan:** ${plan.phases.length} phases, ${plan.phases.reduce((sum, p) => sum + p.tasks.length, 0)} tasks

The delivery agent has prepared an implementation plan. Review the tasks and begin implementation.`,
  };
}

export async function verifyExecution(
  proposal: Proposal,
  options: {
    filesChanged: string[];
    expectedFiles?: string[];
    testOutput?: string;
    testsPassed?: number;
    testsFailed?: number;
    compilationOk?: boolean;
    gitClean?: boolean;
  },
): Promise<ExecutionVerification> {
  const missingFiles = options.expectedFiles?.filter((f) => !options.filesChanged.includes(f)) ?? [];

  let status: VerificationStatus = "success";
  if (missingFiles.length > 0) status = "partial";
  if (options.testsFailed && options.testsFailed > 0) status = "partial";
  if (options.compilationOk === false) status = "failed";

  const verification: ExecutionVerification = {
    proposalId: proposal.id,
    status,
    timestamp: new Date().toISOString(),
    filesChanged: options.filesChanged,
    missingFiles,
    testOutput: options.testOutput,
    testsPassed: options.testsPassed,
    testsFailed: options.testsFailed,
    compilationOk: options.compilationOk ?? true,
    gitClean: options.gitClean ?? true,
    summary: `Verification ${status}: ${options.filesChanged.length} files changed, ${missingFiles.length} missing, tests ${options.testsPassed ?? 0}/${(options.testsPassed ?? 0) + (options.testsFailed ?? 0)}`,
  };

  await storeVerification(proposal.id, verification);
  return verification;
}

export function formatVerification(v: ExecutionVerification): string {
  return `# 🔍 Verification — #${v.proposalId}

**Status:** ${v.status === "success" ? "✅" : v.status === "partial" ? "⚠️" : "❌"} ${v.status}
**Files Changed:** ${v.filesChanged.length}
**Missing Files:** ${v.missingFiles.length > 0 ? v.missingFiles.join(", ") : "none"}
**Tests:** ${v.testsPassed ?? 0} passed${v.testsFailed ? `, ${v.testsFailed} failed` : ""}
**Compilation:** ${v.compilationOk ? "✅" : "❌"}
**Git Clean:** ${v.gitClean ? "✅" : "❌"}

${v.summary}`;
}
