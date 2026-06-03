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
});
