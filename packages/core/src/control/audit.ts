// ============================================================
// Swarm DAO Core — Audit Trail
// ============================================================

import type { AuditEntry, Proposal } from "../types/index.js";
import { getState, recordAudit as persistRecordAudit, getAuditLog, getAllAuditLog } from "../persistence.js";

export { persistRecordAudit as recordAudit, getAuditLog, getAllAuditLog };

export function formatAuditTrail(entries: AuditEntry[], proposalId?: number): string {
  const header = proposalId !== undefined
    ? `# Audit Trail — Proposal #${proposalId}`
    : "# DAO Audit Trail";

  if (entries.length === 0) {
    return `${header}\n\nNo audit entries yet.`;
  }

  let output = `${header}\n\n`;
  for (const entry of entries) {
    output += `**${entry.timestamp}** | **${entry.layer}** | ${entry.action}\n`;
    output += `- Actor: ${entry.actor}\n`;
    output += `- Details: ${entry.details}\n\n`;
  }
  return output;
}

export function getProposalAudit(proposalId: number): AuditEntry[] {
  return getAuditLog(proposalId);
}

export function getFullAudit(): AuditEntry[] {
  return getAllAuditLog();
}