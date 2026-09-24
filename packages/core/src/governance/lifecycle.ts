// ============================================================
// Swarm DAO Core — Proposal Lifecycle Helpers
// ------------------------------------------------------------
// Status transitions live in `proposal.machine.ts` (XState) and
// are applied via `dispatchProposalEvent` (proposal.utils.ts).
// This module keeps the pure, side-effect-free helpers that the
// machine guards and the UI consume: risk classification, human
// approval thresholds, security-review requirements, and labels.
// ============================================================

import type { Proposal, ProposalStatus, RiskZone } from "../types/index.js";
import { PROPOSAL_COUNCIL, PROPOSAL_TYPE, RISK_ZONE_DEFINITIONS } from "../types/index.js";

// ── Risk Zone Classification ─────────────────────────────────

/**
 * Security-sensitive words in a title/description. Matched on word boundaries
 * so "auth" does not match "author". Compound/inflected forms are listed
 * explicitly.
 */
const RED_ZONE_KEYWORD_RE =
  /\b(?:auth|authn|authz|authenticate|authenticated|authentication|authorize|authorized|authorization|authorise|authorised|authorisation|permissions?|security|credentials?|secrets?|tokens?|passwords?|encryption|firewalls?)\b/i;

export function classifyRiskZone(proposal: Proposal): RiskZone {
  // Security and governance changes are classified as red
  if (proposal.type === PROPOSAL_TYPE.SECURITY_CHANGE || proposal.type === PROPOSAL_TYPE.GOVERNANCE_CHANGE) {
    return "red";
  }

  // Check for sensitive keywords in title/description. Word-boundary matching
  // (not substring): the old `includes("auth")` also fired on "author",
  // "authority", "authoritative" and sent innocuous proposals to the red zone
  // (mandatory dry-run). The alternation lists the security forms explicitly
  // so "authentication"/"authorization" still match.
  const text = `${proposal.title} ${proposal.description ?? ""}`;
  if (RED_ZONE_KEYWORD_RE.test(text)) {
    return "red";
  }

  // Default based on type
  if (proposal.type === PROPOSAL_TYPE.RELEASE_CHANGE) return "green";
  if (proposal.type === PROPOSAL_TYPE.PRODUCT_FEATURE) return "orange";

  return "orange";
}

export function getRequiredApprovals(zone: RiskZone): number {
  return RISK_ZONE_DEFINITIONS[zone].humanApprovals;
}

export function requiresSecurityReview(zone: RiskZone): boolean {
  return RISK_ZONE_DEFINITIONS[zone].requiresSecurityReview;
}

// ── Status Labels ────────────────────────────────────────────

export function statusLabel(status: ProposalStatus): string {
  const labels: Record<ProposalStatus, string> = {
    open: "📝 Open",
    deliberating: "🗳️ Deliberating",
    approved: "✅ Approved",
    controlled: "🛡️ Controlled",
    rejected: "❌ Rejected",
    executed: "🚀 Executed",
    failed: "💥 Failed",
  };
  return labels[status];
}

export function getCouncilsForType(type: Proposal["type"]): string[] {
  return PROPOSAL_COUNCIL[type] || [];
}
