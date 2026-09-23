import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveContainedRoot } from "@guyghost/swarm-dao-core";

describe("resolveContainedRoot", () => {
  it("resolves a relative default root under workDir", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-contained-"));
    try {
      const resolved = await resolveContainedRoot(workDir, ".dao/graph-runs");
      expect(resolved).toBe(path.join(await fs.realpath(workDir), ".dao/graph-runs"));
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-contained-abs-"));
    try {
      await expect(resolveContainedRoot(workDir, "/tmp/evil")).rejects.toThrow(/absolute paths are not allowed/);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects .. segments", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-contained-dot-"));
    try {
      await expect(resolveContainedRoot(workDir, "../outside")).rejects.toThrow(/segments are not allowed/);
      await expect(resolveContainedRoot(workDir, ".dao/../secret")).rejects.toThrow(/segments are not allowed/);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects empty roots and null bytes", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-contained-empty-"));
    try {
      await expect(resolveContainedRoot(workDir, "")).rejects.toThrow(/empty roots/);
      await expect(resolveContainedRoot(workDir, "   ")).rejects.toThrow(/empty roots/);
      await expect(resolveContainedRoot(workDir, "foo\0bar")).rejects.toThrow(/null bytes/);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-contained-link-"));
    const outside = await fs.mkdtemp(path.join(tmpdir(), "swarm-contained-out-"));
    try {
      await fs.symlink(outside, path.join(workDir, "escape"));
      await expect(resolveContainedRoot(workDir, "escape")).rejects.toThrow(/escapes base directory/);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
