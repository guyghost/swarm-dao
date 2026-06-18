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

  it("allows paths resolving exactly to the base", async () => {
    const root = path.join(tmpdir(), `swarm-host-${Date.now()}`);
    const baseFile = path.join(root, "base.txt");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(baseFile, "base", "utf-8");
    expect(await readFileContained("", baseFile)).toBe("base");
    await fs.rm(root, { recursive: true, force: true });
  });
});
