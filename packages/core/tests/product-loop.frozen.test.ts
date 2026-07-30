import { describe, expect, it } from "bun:test";
import { validateProductContract } from "../../../tools/product-loop/contract.js";

const root = process.cwd();

describe("product-loop frozen contract", () => {
  it("graph, schema, and XState machine agree on the frozen model", async () => {
    const result = await validateProductContract(root);
    if (!result.valid) {
      // Surface every drift issue so a frozen-set change is self-documenting.
      for (const issue of result.issues) console.error(`  contract drift: ${issue}`);
    }
    expect(result.valid).toBe(true);
    expect(result.modelHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
