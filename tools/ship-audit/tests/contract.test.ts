import { describe, expect, test } from "bun:test";
import { computeShipAuditModelHash, validateShipAuditContract } from "../contract.js";

describe("ship-audit contract", () => {
  test("the graph contract validates and the model hash is stable", async () => {
    const result = await validateShipAuditContract(process.cwd());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    // The exact hash approved by the human owner for run ship-audit-1.
    expect(result.modelHash).toBe("496cd208313d0bff2169346cdc791aeb0e9760bce423c03c63b5c95c090afc3c");
    // Deterministic: recomputation yields the same digest.
    expect(await computeShipAuditModelHash(process.cwd())).toBe(result.modelHash);
  });

  test("anchor commands are frozen", async () => {
    const graph = JSON.parse(await Bun.file("models/ship-audit.graph.json").text());
    expect(Object.keys(graph.anchorCommands).sort()).toEqual([
      "audit-graph-tests",
      "audit-model-contract",
      "audit-regression",
      "audit-runtime-scenario",
      "audit-wiring-contract",
    ]);
    expect(graph.maxRetries).toBe(0);
    expect(graph.proposalStateAuthority).toBe("none");
  });
});
