// ============================================================
// Swarm DAO Core — Audit JSONL store (ADR-005)
// ============================================================
// Pure line-format helpers for the append-only audit trail. The
// repository adapter owns the I/O (append + load); this module owns
// the format rules: one compact JSON AuditEntry per line, tolerant
// parsing (a torn or damaged line is skipped, never fatal — it is a
// log, and the loader dedupes by id anyway).

import type { AuditEntry } from "../../types/index.js";

/** Single source for the audit trail file name used by every persistence path. */
export const AUDIT_JSONL_FILE_NAME = "audit.jsonl";

/** Compact single-line serialization (the pretty format is for state.json). */
export function auditLine(entry: AuditEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/** Parse JSONL content tolerantly: empty lines, torn/corrupt lines and
 *  structurally invalid entries (missing or non-positive-integer id) are
 *  skipped and counted — the audit trail is a log, and the loader dedupes
 *  by id anyway. Returns the valid entries plus the skipped line count so
 *  the I/O-owning adapter can warn about forensically relevant damage. */
export function parseAuditJsonl(raw: string): { entries: AuditEntry[]; skipped: number } {
  const entries: AuditEntry[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditEntry;
      const isEntry =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && isPositiveInteger(parsed.id);
      if (!isEntry) throw new Error("not an audit entry");
      entries.push(parsed);
    } catch {
      // Torn tail (crash mid-append), damaged line, or entry without a usable
      // id: skip and count — the adapter warns so the damage is visible.
      skipped++;
    }
  }
  return { entries, skipped };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Fold parsed JSONL entries into an in-memory audit log, deduplicating by
 *  id (first occurrence wins — entries are immutable once written). */
export function mergeAuditEntries(auditLog: AuditEntry[], entries: AuditEntry[]): void {
  const known = new Set(auditLog.map((entry) => entry.id));
  for (const entry of entries) {
    if (!known.has(entry.id)) {
      known.add(entry.id);
      auditLog.push(entry);
    }
  }
  auditLog.sort((left, right) => left.id - right.id);
}
