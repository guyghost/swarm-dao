import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execCommand, readFileContained, writeFileContained } from "../src/utils/host.js";

describe("utils/host.ts", () => {
  it("executes safe commands", async () => {
    const result = await execCommand("node --version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v");
  });

  it("rejects unsafe shell metacharacters", async () => {
    const result = await execCommand("echo ok; echo bad");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsafe command");
  });

  it("enforces contained file read/write", async () => {
    const root = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await writeFileContained("inside.txt", "hello", root);
    expect(await readFileContained("inside.txt", root)).toBe("hello");
    await expect(readFileContained("../outside.txt", root)).rejects.toThrow("Path traversal denied");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects partial-prefix sibling paths", async () => {
    const parent = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    const root = path.join(parent, "root");
    const sibling = path.join(parent, "root2");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await expect(writeFileContained("../root2/outside.txt", "nope", root)).rejects.toThrow("Path traversal denied");
    await fs.rm(parent, { recursive: true, force: true });
  });

  it("allows paths resolving exactly to the base directory", async () => {
    const root = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    const result = await readFileContained(".", root).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
    if (!result.ok) {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      expect(message).not.toContain("Path traversal denied");
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects absolute paths when baseDir is set", async () => {
    const root = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await expect(readFileContained("/etc/passwd", root)).rejects.toThrow("Path traversal denied");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects null bytes in paths", async () => {
    const root = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await expect(readFileContained("safe\0.txt", root)).rejects.toThrow("Path traversal denied");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects symlink escapes outside the base directory", async () => {
    const parent = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "leaked", "utf-8");
    await fs.symlink(outside, path.join(root, "link-out"));

    await expect(readFileContained("link-out/secret.txt", root)).rejects.toThrow("Path traversal denied");
    await fs.rm(parent, { recursive: true, force: true });
  });

  it("rejects writes through symlink escapes when parent segments are missing", async () => {
    const parent = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(root, "link-out"));

    await expect(writeFileContained("link-out/nested/new.txt", "leaked", root)).rejects.toThrow(
      "Path traversal denied",
    );
    await expect(fs.readFile(path.join(outside, "nested", "new.txt"), "utf-8")).rejects.toThrow();
    await fs.rm(parent, { recursive: true, force: true });
  });
});
