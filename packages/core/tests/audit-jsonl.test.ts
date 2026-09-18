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
    expect(parseAuditJsonl(raw).map((e) => e.id)).toEqual([1, 2]);
    expect(parseAuditJsonl(raw)[1]?.action).toBe("vote_cast");
  });

  it("skips empty and corrupt lines (torn tail, damaged middle)", () => {
    const raw = auditLine(entry(1)) + "\n" + '{"id":2,"torn' + "\n" + "\n" + "not json at all\n" + auditLine(entry(3));
    const parsed = parseAuditJsonl(raw);
    expect(parsed.map((e) => e.id)).toEqual([1, 3]);
  });

  it("returns an empty list for whitespace-only content", () => {
    expect(parseAuditJsonl("")).toEqual([]);
    expect(parseAuditJsonl("\n\n")).toEqual([]);
  });

  it("keeps entries with optional metadata intact", () => {
    const withMeta: AuditEntry = { ...entry(7), metadata: { weight: 2, cascade: true } };
    expect(parseAuditJsonl(auditLine(withMeta))[0]?.metadata).toEqual({ weight: 2, cascade: true });
  });
});
