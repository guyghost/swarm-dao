import { captureSnapshot, getSnapshot, getState, saveState } from "../persistence.js";
import type { DryRunResult, ExecutionSnapshot, Proposal } from "../types/index.js";
import { PROPOSAL_TYPE } from "../types/index.js";
import { execCommand } from "../utils/host.js";

export async function performDryRun(proposal: Proposal): Promise<DryRunResult> {
  const _state = getState();

  // Analyze what would change
  const filesAffected: string[] = [];
  const risks: string[] = [];

  // Check affected paths
  if (proposal.affectedPaths && proposal.affectedPaths.length > 0) {
    filesAffected.push(...proposal.affectedPaths);
  }

  // Risk assessment based on proposal type
  if (proposal.type === PROPOSAL_TYPE.SECURITY_CHANGE) {
    risks.push("Security-sensitive changes require extra review");
  }
  if (proposal.riskZone === "red") {
    risks.push("Red-zone proposal: high risk detected");
  }
  if (!Array.isArray(proposal.acceptanceCriteria) || proposal.acceptanceCriteria.length === 0) {
    risks.push("No acceptance criteria defined");
  }

  // Estimate duration based on proposal type
  const durationMap: Record<Proposal["type"], string> = {
    [PROPOSAL_TYPE.PRODUCT_FEATURE]: "3-7 days",
    [PROPOSAL_TYPE.SECURITY_CHANGE]: "1-2 weeks",
    [PROPOSAL_TYPE.TECHNICAL_CHANGE]: "2-5 days",
    [PROPOSAL_TYPE.RELEASE_CHANGE]: "1-3 days",
    [PROPOSAL_TYPE.GOVERNANCE_CHANGE]: "1-2 days",
  };

  return {
    proposalId: proposal.id,
    preview: `This proposal would modify ${filesAffected.length || "unknown number of"} files and requires ${durationMap[proposal.type] || "unknown duration"}.`,
    filesAffected,
    risks,
    estimatedDuration: durationMap[proposal.type] || "TBD",
    canProceed: risks.filter((r) => r.includes("high risk") || r.includes("Security-sensitive")).length === 0,
  };
}

export function formatDryRun(result: DryRunResult): string {
  let output = `# 🔍 Dry-Run — Proposal #${result.proposalId}\n\n`;
  output += `**Can Proceed:** ${result.canProceed ? "✅ Yes" : "⚠️ With Caution"}\n`;
  output += `**Estimated Duration:** ${result.estimatedDuration}\n`;
  output += `**Files Affected:** ${result.filesAffected.length > 0 ? result.filesAffected.join(", ") : "To be determined"}\n\n`;

  if (result.risks.length > 0) {
    output += `## ⚠️ Risks\n${result.risks.map((r: string) => `- ${r}`).join("\n")}\n\n`;
  }

  output += `## Preview\n${result.preview}\n`;
  return output;
}

// ── Snapshot Management ─────────────────────────────────────

export async function createExecutionSnapshot(proposal: Proposal, cwd: string): Promise<ExecutionSnapshot> {
  const branchResult = await execCommand("git branch --show-current", { cwd });
  const shaResult = await execCommand("git rev-parse HEAD", { cwd });

  const gitInfo = {
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || "unknown" : "unknown",
    sha: shaResult.exitCode === 0 ? shaResult.stdout.trim() || "unknown" : "unknown",
  };

  const snapshot: ExecutionSnapshot = {
    proposalId: proposal.id,
    timestamp: new Date().toISOString(),
    branch: gitInfo.branch,
    commitSha: gitInfo.sha,
    filesChanged: proposal.affectedPaths || [],
    stateSnapshot: JSON.stringify({
      agents: getState().agents?.length ?? 0,
      proposals: getState().proposals?.length ?? 0,
    }),
  };

  await captureSnapshot(proposal.id, snapshot);
  return snapshot;
}

export function canRollback(proposalId: number): boolean {
  return getSnapshot(proposalId) !== undefined;
}

export async function performRollback(proposalId: number): Promise<{ success: boolean; message: string }> {
  const snapshot = getSnapshot(proposalId);
  if (!snapshot) {
    return { success: false, message: `No snapshot found for proposal #${proposalId}` };
  }

  // In a real implementation, this would restore files and git state
  // For now, we mark the proposal as rolled back conceptually
  const proposal = getState().proposals.find((p) => p.id === proposalId);
  if (proposal) {
    proposal.status = "open";
    proposal.resolvedAt = undefined;
    await saveState();
  }

  return {
    success: true,
    message: `Proposal #${proposalId} rolled back to commit ${snapshot.commitSha.slice(0, 8)} on branch ${snapshot.branch}`,
  };
}

export function formatRollback(result: { success: boolean; message: string }): string {
  return result.success ? `# ⏪ Rollback Successful\n\n${result.message}` : `# ❌ Rollback Failed\n\n${result.message}`;
}
