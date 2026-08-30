// ============================================================
// Swarm DAO Core — Edit Gate (mode-based path governance)
// ============================================================
// Wires the `mode` and `criticalPaths` configuration into a deterministic
// pre-edit decision agents can consult before touching the repository:
//
// - opt-in (default): everything is allowed; critical paths are flagged
//   informationally.
// - suggest: everything is allowed; uncovered critical paths produce a
//   non-blocking nudge toward the proposal workflow.
// - enforce: critical paths are only editable when an approved,
//   controlled, or executed proposal declares them in affectedPaths.
//
// Pure: no I/O, no clock, no host SDK. The host handler feeds it the
// project config and the approved proposals; the model decides.

import { type ActivationMode, isCriticalPath } from "../config.js";

/** Proposals whose affectedPaths carry approval authority. */
export interface EditGateApproval {
  proposalId: number;
  affectedPaths?: string[];
  status: string;
}

export interface EditPathVerdict {
  path: string;
  /** True when the path matches a criticalPaths glob. */
  critical: boolean;
  /** May the agent edit this path under the configured mode? */
  allowed: boolean;
  reason: string;
  /** Proposal whose affectedPaths cover this path, when relevant. */
  coveredByProposalId?: number;
}

export interface EditGateDecision {
  mode: ActivationMode;
  /** True only when every requested path is allowed. */
  allowed: boolean;
  verdicts: readonly EditPathVerdict[];
  /** Non-blocking nudge (suggest) or required next step (enforce). */
  guidance: string | null;
}

const AUTHORITY_STATUSES = new Set(["approved", "controlled", "executed"]);

const isAuthority = (approval: EditGateApproval): boolean =>
  AUTHORITY_STATUSES.has(approval.status) && Boolean(approval.affectedPaths?.length);

export function evaluateEditGate(input: {
  paths: readonly string[];
  mode: ActivationMode;
  criticalPaths: readonly string[];
  approved: readonly EditGateApproval[];
}): EditGateDecision {
  const authorities = input.approved.filter(isAuthority);
  const seen = new Set<string>();
  const verdicts: EditPathVerdict[] = [];

  for (const raw of input.paths) {
    const path = raw.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);

    const critical = isCriticalPath(path, [...input.criticalPaths]);
    const covering = critical
      ? authorities.find((approval) => isCriticalPath(path, approval.affectedPaths ?? []))
      : undefined;

    if (!critical) {
      verdicts.push({ path, critical, allowed: true, reason: "not a critical path" });
      continue;
    }

    if (input.mode === "opt-in") {
      verdicts.push({
        path,
        critical,
        allowed: true,
        reason: covering
          ? `critical path, covered by approved proposal #${covering.proposalId}`
          : "critical path (mode is opt-in: edits allowed, proposal optional)",
      });
      continue;
    }

    if (input.mode === "suggest") {
      verdicts.push({
        path,
        critical,
        allowed: true,
        reason: covering
          ? `critical path, covered by approved proposal #${covering.proposalId}`
          : "critical path — consider governing this change with a proposal",
        ...(covering ? { coveredByProposalId: covering.proposalId } : {}),
      });
      continue;
    }

    // enforce
    if (covering) {
      verdicts.push({
        path,
        critical,
        allowed: true,
        reason: `critical path covered by approved proposal #${covering.proposalId}`,
        coveredByProposalId: covering.proposalId,
      });
    } else {
      verdicts.push({
        path,
        critical,
        allowed: false,
        reason: "enforce mode: critical path without an approved proposal",
      });
    }
  }

  const denied = verdicts.filter((verdict) => !verdict.allowed);
  const uncoveredCritical = verdicts.filter((verdict) => verdict.critical && !verdict.coveredByProposalId);

  let guidance: string | null = null;
  if (input.mode === "suggest" && uncoveredCritical.length > 0) {
    guidance =
      "Suggestion: create a proposal (`dao_propose`) covering these critical paths and deliberate it before proceeding.";
  } else if (input.mode === "enforce" && denied.length > 0) {
    guidance =
      "Blocked by enforce mode: create a proposal (`dao_propose`) with these paths in affectedPaths, deliberate, and get it approved before editing.";
  }

  return { mode: input.mode, allowed: denied.length === 0, verdicts, guidance };
}

/** Human-readable rendering; pure formatting. */
export function formatEditGate(decision: EditGateDecision): string {
  const header = decision.allowed ? "# ✅ Edit Gate — Allowed" : `# 🛑 Edit Gate — Blocked (${decision.mode} mode)`;
  const rows = decision.verdicts
    .map((verdict) => {
      const flag = verdict.allowed ? "✅" : "❌";
      const critical = verdict.critical ? " [critical]" : "";
      const covered = verdict.coveredByProposalId ? ` (covered by #${verdict.coveredByProposalId})` : "";
      return `- ${flag} \`${verdict.path}\`${critical}${covered} — ${verdict.reason}`;
    })
    .join("\n");
  const guidance = decision.guidance ? `\n\n${decision.guidance}` : "";
  return `${header}\n\nMode: **${decision.mode}**\n\n${rows}${guidance}`;
}
