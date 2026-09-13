import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveContainedRoot } from "../src/contained-root.js";

describe("resolveContainedRoot", () => {
  it("resolves a relative default root under workDir", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-pi-contained-"));
    try {
      const resolved = await resolveContainedRoot(workDir, ".dao/graph-runs");
      expect(resolved).toBe(path.join(await fs.realpath(workDir), ".dao/graph-runs"));
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths and .. segments", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-pi-contained-bad-"));
    try {
      await expect(resolveContainedRoot(workDir, "/tmp/evil")).rejects.toThrow(/absolute paths are not allowed/);
      await expect(resolveContainedRoot(workDir, "../outside")).rejects.toThrow(/segments are not allowed/);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});
