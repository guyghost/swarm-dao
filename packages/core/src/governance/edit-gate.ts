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

/**
 * Lexically normalize a repository-relative path so glob matching cannot be
 * evaded by spelling variants (absolute paths, `./` prefixes, `a/../b`
 * segments, duplicate slashes). Fail closed: anything that cannot be
 * normalized to a deterministic in-repo path is refused, never allowed.
 */
export function normalizeEditPath(raw: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (raw.length === 0) return { ok: false, reason: "empty path" };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { ok: false, reason: "absolute paths are not supported — pass repository-relative paths" };
  }
  if (raw.includes("\\")) {
    return { ok: false, reason: "backslashes are not supported — use forward slashes" };
  }

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        return { ok: false, reason: "path escapes the repository root" };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, reason: "path normalizes to the repository root" };
  return { ok: true, path: segments.join("/") };
}

const isAuthority = (approval: EditGateApproval): boolean =>
  AUTHORITY_STATUSES.has(approval.status) && Boolean(approval.affectedPaths?.length);

export function evaluateEditGate(input: {
  paths: readonly string[];
  mode: ActivationMode;
  criticalPaths: readonly string[];
  approved: readonly EditGateApproval[];
}): EditGateDecision {
  // Fail open on unknown modes, consistent with canEditWithoutProposal():
  // only an explicit "enforce" ever blocks. loadConfig merges unvalidated
  // JSON, so a typo in .dao/config.json must not lock the repository.
  const mode: ActivationMode = input.mode === "enforce" || input.mode === "suggest" ? input.mode : "opt-in";
  const authorities = input.approved.filter(isAuthority);
  const seen = new Set<string>();
  const verdicts: EditPathVerdict[] = [];

  for (const raw of input.paths) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    // Unmatchable spellings are refused in every mode — a path the gate
    // cannot normalize must never come back as allowed.
    const normalized = normalizeEditPath(trimmed);
    if (!normalized.ok) {
      verdicts.push({
        path: trimmed,
        critical: false,
        allowed: false,
        reason: `unmatchable path: ${normalized.reason}`,
      });
      continue;
    }
    const path = normalized.path;
    if (seen.has(path)) continue;
    seen.add(path);

    const critical = isCriticalPath(path, [...input.criticalPaths]);
    const covering = critical
      ? authorities.find((approval) => isCriticalPath(path, approval.affectedPaths ?? []))
      : undefined;

    if (!critical) {
      verdicts.push({ path, critical, allowed: true, reason: "not a critical path" });
      continue;
    }

    if (mode === "opt-in") {
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

    if (mode === "suggest") {
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
  if (mode === "suggest" && uncoveredCritical.length > 0) {
    guidance =
      "Suggestion: create a proposal (`dao_propose`) covering these critical paths and deliberate it before proceeding.";
  } else if (mode === "enforce" && denied.length > 0) {
    guidance =
      "Blocked by enforce mode: create a proposal (`dao_propose`) with these paths in affectedPaths, deliberate, and get it approved before editing.";
  }

  return { mode, allowed: denied.length === 0, verdicts, guidance };
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
