import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CYCLE_EVIDENCE_FOLDER, resolveEvidenceRoot, SERIES_EVIDENCE_FOLDER } from "../src/evidence-root.js";

describe("resolveEvidenceRoot (improvement-loop)", () => {
  it("prefers an explicit path, then evidence/, then .dao/, then the model path for series and cycles", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "improvement-evidence-root-"));
    try {
      for (const folder of [SERIES_EVIDENCE_FOLDER, CYCLE_EVIDENCE_FOLDER]) {
        expect(resolveEvidenceRoot(folder, undefined, cwd)).toBe(join(cwd, "evidence", folder));
        expect(resolveEvidenceRoot(folder, `custom/${folder}`, cwd)).toBe(join(cwd, "custom", folder));

        await mkdir(join(cwd, ".dao", folder), { recursive: true });
        expect(resolveEvidenceRoot(folder, undefined, cwd)).toBe(join(cwd, ".dao", folder));

        await mkdir(join(cwd, "evidence", folder), { recursive: true });
        expect(resolveEvidenceRoot(folder, undefined, cwd)).toBe(join(cwd, "evidence", folder));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
