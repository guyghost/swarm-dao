import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPH_EVIDENCE_FOLDER, resolveEvidenceRoot } from "../src/evidence-root.js";

describe("resolveEvidenceRoot", () => {
  it("prefers an explicit path, then evidence/, then .dao/, then the model path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "graph-evidence-root-"));
    try {
      expect(resolveEvidenceRoot(GRAPH_EVIDENCE_FOLDER, undefined, cwd)).toBe(
        join(cwd, "evidence", GRAPH_EVIDENCE_FOLDER),
      );
      expect(resolveEvidenceRoot(GRAPH_EVIDENCE_FOLDER, "custom/runs", cwd)).toBe(join(cwd, "custom", "runs"));

      await mkdir(join(cwd, ".dao", GRAPH_EVIDENCE_FOLDER), { recursive: true });
      expect(resolveEvidenceRoot(GRAPH_EVIDENCE_FOLDER, undefined, cwd)).toBe(join(cwd, ".dao", GRAPH_EVIDENCE_FOLDER));

      await mkdir(join(cwd, "evidence", GRAPH_EVIDENCE_FOLDER), { recursive: true });
      expect(resolveEvidenceRoot(GRAPH_EVIDENCE_FOLDER, undefined, cwd)).toBe(
        join(cwd, "evidence", GRAPH_EVIDENCE_FOLDER),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
