import { analyzeProposalDryRun } from "../domain/dry-run.js";
import { captureSnapshot, getSnapshot, getState } from "../persistence.js";
import type { DryRunResult, ExecutionSnapshot, Proposal } from "../types/index.js";
import { execCommand } from "../utils/host.js";

export async function performDryRun(proposal: Proposal): Promise<DryRunResult> {
  return analyzeProposalDryRun(proposal);
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

  return {
    success: true,
    message: `Proposal #${proposalId} rolled back to commit ${snapshot.commitSha.slice(0, 8)} on branch ${snapshot.branch}`,
  };
}

export function formatRollback(result: { success: boolean; message: string }): string {
  return result.success ? `# ⏪ Rollback Successful\n\n${result.message}` : `# ❌ Rollback Failed\n\n${result.message}`;
}
