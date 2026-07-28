import { afterEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeHostAdapter, resolveDaoRoot, startClaudeServer } from "../src/index.js";

describe("claude-adapter", () => {
  afterEach(() => {
    mock.restore();
  });

  it("builds a host adapter with hostId claude", () => {
    const adapter = createClaudeHostAdapter("/tmp/dao");
    expect(adapter.hostId).toBe("claude");
    expect(adapter.getWorkingDirectory()).toBe("/tmp/dao");
  });

  it("exposes resolveDaoRoot and startClaudeServer", () => {
    expect(typeof resolveDaoRoot).toBe("function");
    expect(typeof startClaudeServer).toBe("function");
  });

  it("startClaudeServer initializes storage and connects stdio transport", async () => {
    const cwd = path.join(tmpdir(), `claude-server-${Date.now()}`);
    const transportStart = mock(async () => {});
    mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {
        start = transportStart;
      },
    }));

    try {
      await startClaudeServer(cwd);
      await expect(fs.stat(path.join(cwd, ".dao"))).resolves.toBeDefined();
      expect(transportStart).toHaveBeenCalled();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a manual-dispatch error from spawnAgent", async () => {
    const adapter = createClaudeHostAdapter("/tmp/dao");
    const result = await adapter.spawnAgent({
      agent: { id: "pm", name: "Product Manager", role: "product" },
      prompt: "x",
    });
    expect(result.error).toBeDefined();
  });
});
