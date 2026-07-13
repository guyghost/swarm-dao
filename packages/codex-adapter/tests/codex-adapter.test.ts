import { afterEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexHostAdapter, resolveDaoRoot, startCodexServer } from "../src/index.js";

describe("codex-adapter", () => {
  afterEach(() => {
    mock.restore();
  });

  it("builds a host adapter with hostId codex", () => {
    const adapter = createCodexHostAdapter("/tmp/dao");
    expect(adapter.hostId).toBe("codex");
    expect(adapter.getWorkingDirectory()).toBe("/tmp/dao");
  });

  it("exposes resolveDaoRoot and startCodexServer", () => {
    expect(typeof resolveDaoRoot).toBe("function");
    expect(typeof startCodexServer).toBe("function");
  });

  it("startCodexServer initializes storage and connects stdio transport", async () => {
    const cwd = path.join(tmpdir(), `codex-server-${Date.now()}`);
    const transportStart = mock(async () => {});
    mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {
        start = transportStart;
      },
    }));

    try {
      await startCodexServer(cwd);
      await expect(fs.stat(path.join(cwd, ".dao"))).resolves.toBeDefined();
      expect(transportStart).toHaveBeenCalled();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a manual-dispatch error from spawnAgent", async () => {
    const adapter = createCodexHostAdapter("/tmp/dao");
    const result = await adapter.spawnAgent({
      agent: { id: "pm", name: "Product Manager", role: "product" },
      prompt: "x",
    });
    expect(result.error).toBeDefined();
  });
});
