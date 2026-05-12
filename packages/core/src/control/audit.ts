// ============================================================
// Swarm DAO Core — Audit Trail
// ============================================================

import { getAllAuditLog, getAuditLog, recordAudit as persistRecordAudit } from "../persistence.js";
import type { AuditEntry } from "../types/index.js";

export { getAllAuditLog, getAuditLog, persistRecordAudit as recordAudit };

export function formatAuditTrail(entries: AuditEntry[], proposalId?: number): string {
  const header = proposalId !== undefined ? `# Audit Trail — Proposal #${proposalId}` : "# DAO Audit Trail";

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
