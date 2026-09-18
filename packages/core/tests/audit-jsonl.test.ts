import { describe, expect, it } from "bun:test";
import type { AuditEntry } from "@guyghost/swarm-dao-core";
import { AUDIT_JSONL_FILE_NAME, auditLine, parseAuditJsonl } from "../src/adapters/persistence/audit-jsonl.js";

function entry(id: number, action = "vote_cast"): AuditEntry {
  return {
    id,
    timestamp: "2031-01-01T00:00:00.000Z",
    proposalId: (id % 10) + 1,
    layer: "governance",
    action,
    actor: `agent-${id % 3}`,
    details: `Entry ${id}: ${action}`,
  };
}

describe("audit jsonl store", () => {
  it("uses a stable file name", () => {
    expect(AUDIT_JSONL_FILE_NAME).toBe("audit.jsonl");
  });

  it("round-trips entries line by line", () => {
    const raw = [entry(1), entry(2)].map(auditLine).join("");
    const { entries, skipped } = parseAuditJsonl(raw);
    expect(skipped).toBe(0);
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
    expect(entries[1]?.action).toBe("vote_cast");
  });

  it("skips empty and corrupt lines (torn tail, damaged middle) and counts them", () => {
    const raw = `${auditLine(entry(1))}
{"id":2,"torn

not json at all
${auditLine(entry(3))}`;
    const { entries, skipped } = parseAuditJsonl(raw);
    expect(entries.map((e) => e.id)).toEqual([1, 3]);
    expect(skipped).toBe(2); // torn tail + damaged line; empty lines are separators
  });

  it("skips structurally-invalid entries without a usable id", () => {
    const raw = `${auditLine(entry(1))}{"id":"two"}
{}
${auditLine(entry(2))}`;
    const { entries, skipped } = parseAuditJsonl(raw);
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
    expect(skipped).toBe(2);
  });

  it("returns an empty list for whitespace-only content", () => {
    expect(parseAuditJsonl("").entries).toEqual([]);
    expect(parseAuditJsonl("\n\n").entries).toEqual([]);
  });

  it("keeps entries with optional metadata intact", () => {
    const withMeta: AuditEntry = { ...entry(7), metadata: { weight: 2, cascade: true } };
    const { entries } = parseAuditJsonl(auditLine(withMeta));
    expect(entries[0]?.metadata).toEqual({ weight: 2, cascade: true });
  });
});
