import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveContainedRoot } from "@guyghost/swarm-dao-core";

describe("resolveContainedRoot", () => {
  it("resolves a relative default root under workDir", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-oc-contained-"));
    try {
      const resolved = await resolveContainedRoot(workDir, ".dao/product-loops");
      expect(resolved).toBe(path.join(await fs.realpath(workDir), ".dao/product-loops"));
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths and .. segments", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-oc-contained-bad-"));
    try {
      await expect(resolveContainedRoot(workDir, "/tmp/evil")).rejects.toThrow(/absolute paths are not allowed/);
      await expect(resolveContainedRoot(workDir, "../outside")).rejects.toThrow(/segments are not allowed/);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});
