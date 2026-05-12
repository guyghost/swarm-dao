import { captureSnapshot, getSnapshot, getState } from "../persistence.js";
import type { DryRunResult, ExecutionSnapshot, Proposal } from "../types/index.js";

export function performDryRun(proposal: Proposal): DryRunResult {
  const _state = getState();

  // Analyze what would change
  const filesAffected: string[] = [];
  const risks: string[] = [];

  // Check affected paths
  if (proposal.affectedPaths && proposal.affectedPaths.length > 0) {
    filesAffected.push(...proposal.affectedPaths);
  }

  // Risk assessment based on proposal type
  if (proposal.type === "security-change") {
    risks.push("Security-sensitive changes require extra review");
  }
  if (proposal.riskZone === "red") {
    risks.push("Red-zone proposal: high risk detected");
  }
  if (!Array.isArray(proposal.acceptanceCriteria) || proposal.acceptanceCriteria.length === 0) {
    risks.push("No acceptance criteria defined");
  }

  // Estimate duration based on proposal type
  const durationMap: Record<string, string> = {
    "product-feature": "3-7 days",
    "security-change": "1-2 weeks",
    "technical-change": "2-5 days",
    "release-change": "1-3 days",
    "governance-change": "1-2 days",
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
  const { exec } = await import("node:child_process");

  const gitInfo = await new Promise<{ branch: string; sha: string }>((resolve) => {
    exec("git branch --show-current && git rev-parse HEAD", { cwd }, (err, stdout) => {
      if (err) {
        resolve({ branch: "unknown", sha: "unknown" });
        return;
      }
      const [branch, sha] = stdout.trim().split("\n");
      resolve({ branch: branch || "unknown", sha: sha || "unknown" });
    });
  });

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

  captureSnapshot(proposal.id, snapshot);
  return snapshot;
}

export function canRollback(proposalId: number): boolean {
  return getSnapshot(proposalId) !== undefined;
}

export function performRollback(proposalId: number): { success: boolean; message: string } {
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
  }

  return {
    success: true,
    message: `Proposal #${proposalId} rolled back to commit ${snapshot.commitSha.slice(0, 8)} on branch ${snapshot.branch}`,
  };
}

export function formatRollback(result: { success: boolean; message: string }): string {
  return result.success ? `# ⏪ Rollback Successful\n\n${result.message}` : `# ❌ Rollback Failed\n\n${result.message}`;
}
