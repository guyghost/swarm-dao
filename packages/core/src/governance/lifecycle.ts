// ============================================================
// Swarm DAO Core — Proposal Lifecycle & State Machine
// ============================================================

import type { Proposal, ProposalStatus, RiskZone } from "../types/index.js";
import { PROPOSAL_COUNCIL, PROPOSAL_TYPE, RISK_ZONE_DEFINITIONS } from "../types/index.js";

// ── Transitions ──────────────────────────────────────────────

const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  open: ["deliberating"],
  deliberating: ["approved", "rejected"],
  approved: ["controlled", "rejected", "failed"],
  controlled: ["executed", "failed"],
  rejected: [],
  executed: [],
  failed: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionProposal(
  proposal: Proposal,
  action: "deliberate" | "approve" | "reject" | "control" | "execute" | "fail",
): { success: boolean; newStatus?: ProposalStatus; error?: string } {
  const transitions: Record<string, Record<string, ProposalStatus>> = {
    open: { deliberate: "deliberating" },
    deliberating: { approve: "approved", reject: "rejected" },
    approved: { control: "controlled", reject: "rejected", fail: "failed" },
    controlled: { execute: "executed", fail: "failed" },
  };

  const newStatus = transitions[proposal.status]?.[action];
  if (!newStatus) {
    return { success: false, error: `Cannot ${action} from ${proposal.status}` };
  }

  proposal.status = newStatus;
  if (["rejected", "executed", "failed"].includes(newStatus)) {
    proposal.resolvedAt = new Date().toISOString();
  }

  return { success: true, newStatus };
}

// ── Risk Zone Classification ─────────────────────────────────

export function classifyRiskZone(proposal: Proposal): RiskZone {
  // Security and governance changes are classified as red
  if (proposal.type === PROPOSAL_TYPE.SECURITY_CHANGE || proposal.type === PROPOSAL_TYPE.GOVERNANCE_CHANGE) {
    return "red";
  }

  // Check for sensitive keywords in title/description
  const text = `${proposal.title} ${proposal.description}`.toLowerCase();
  const redKeywords = [
    "auth",
    "permission",
    "security",
    "credential",
    "secret",
    "token",
    "password",
    "encryption",
    "firewall",
  ];
  if (redKeywords.some((k) => text.includes(k))) {
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
