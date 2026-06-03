import { describe, expect, it } from "bun:test";
import { formatAuditTrail } from "../src/control/audit.js";
import type { AuditEntry } from "../src/types/index.js";

describe("control/audit.ts", () => {
  it("formats empty and non-empty audit trails", () => {
    expect(formatAuditTrail([], 1)).toContain("No audit entries yet");

    const entries: AuditEntry[] = [
      {
        id: 1,
        timestamp: new Date().toISOString(),
        proposalId: 1,
        layer: "governance",
        action: "proposal-created",
        actor: "user",
        details: "Created",
      },
    ];
    expect(formatAuditTrail(entries, 1)).toContain("proposal-created");
  });
});
