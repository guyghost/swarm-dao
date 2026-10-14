import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_EVIDENCE_FOLDER, resolveEvidenceRoot } from "../src/evidence-root.js";

describe("resolveEvidenceRoot (product-loop)", () => {
  it("prefers an explicit path, then evidence/, then .dao/, then the model path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "product-evidence-root-"));
    try {
      expect(resolveEvidenceRoot(PRODUCT_EVIDENCE_FOLDER, undefined, cwd)).toBe(
        join(cwd, "evidence", PRODUCT_EVIDENCE_FOLDER),
      );
      expect(resolveEvidenceRoot(PRODUCT_EVIDENCE_FOLDER, "custom/product-runs", cwd)).toBe(
        join(cwd, "custom", "product-runs"),
      );

      await mkdir(join(cwd, ".dao", PRODUCT_EVIDENCE_FOLDER), { recursive: true });
      expect(resolveEvidenceRoot(PRODUCT_EVIDENCE_FOLDER, undefined, cwd)).toBe(
        join(cwd, ".dao", PRODUCT_EVIDENCE_FOLDER),
      );

      await mkdir(join(cwd, "evidence", PRODUCT_EVIDENCE_FOLDER), { recursive: true });
      expect(resolveEvidenceRoot(PRODUCT_EVIDENCE_FOLDER, undefined, cwd)).toBe(
        join(cwd, "evidence", PRODUCT_EVIDENCE_FOLDER),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
