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
 * The "auth" family must be matched on WORD BOUNDARIES: a bare substring test
 * fired on "author"/"authority"/"authoritative" and sent innocuous proposals to
 * the red zone (mandatory dry-run). The alternation enumerates the security
 * forms — prefix (un/re/de/pre/post/multi/non) + authorize/authorise/
 * authenticate/authn/authz, plus oauth/oauth2 — so compound terms such as
 * "unauthorized", "reauthentication" and "OAuth" still match while "author"
 * does not (a pure `\bauth\b` would drop those compounds).
 */
const RED_ZONE_AUTH_RE =
  /\b(?:(?:un|re|de|pre|post|multi|non)?auth(?:entication|enticate|enticated|orization|orisation|orized|orised|orize|orise|n|z)?|oauth2?)\b/i;

/**
 * The remaining keywords are unambiguous stems, kept on SUBSTRING matching so
 * legitimate compounds ("cybersecurity", "passwordless") are not silently
 * dropped by a word boundary.
 */
const RED_ZONE_SUBSTRING_KEYWORDS = [
  "permission",
  "security",
  "credential",
  "secret",
  "token",
  "password",
  "encryption",
  "firewall",
] as const;

function hasRedZoneKeyword(text: string): boolean {
  if (RED_ZONE_AUTH_RE.test(text)) return true;
  const lower = text.toLowerCase();
  return RED_ZONE_SUBSTRING_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function classifyRiskZone(proposal: Proposal): RiskZone {
  // Security and governance changes are classified as red
  if (proposal.type === PROPOSAL_TYPE.SECURITY_CHANGE || proposal.type === PROPOSAL_TYPE.GOVERNANCE_CHANGE) {
    return "red";
  }

  const text = `${proposal.title} ${proposal.description ?? ""}`;
  if (hasRedZoneKeyword(text)) {
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
