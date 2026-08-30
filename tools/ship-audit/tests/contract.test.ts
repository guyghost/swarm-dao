import { describe, expect, test } from "bun:test";
import { computeShipAuditModelHash, validateShipAuditContract } from "../contract.js";

describe("ship-audit contract", () => {
  test("the graph contract validates and the model hash is stable", async () => {
    const result = await validateShipAuditContract(process.cwd());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    // The exact hash approved by the human owner for run ship-audit-1.
    expect(result.modelHash).toBe("482756e9ce256bc7c4439dc22020577e0c22c8c34b7cd083dc893456e4158ad3");
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
