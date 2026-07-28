import { afterEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCopilotHostAdapter, resolveDaoRoot, startCopilotServer } from "../src/index.js";

describe("copilot-adapter", () => {
  afterEach(() => {
    mock.restore();
  });

  it("builds a host adapter with hostId copilot", () => {
    const adapter = createCopilotHostAdapter("/tmp/dao");
    expect(adapter.hostId).toBe("copilot");
    expect(adapter.getWorkingDirectory()).toBe("/tmp/dao");
    expect(adapter.hasCapability("read_file")).toBe(true);
    expect(adapter.hasCapability("spawn_agent")).toBe(false);
  });

  it("exposes resolveDaoRoot", () => {
    expect(typeof resolveDaoRoot).toBe("function");
  });

  it("exposes startCopilotServer", () => {
    expect(typeof startCopilotServer).toBe("function");
  });

  it("startCopilotServer initializes storage and connects stdio transport", async () => {
    const cwd = path.join(tmpdir(), `copilot-server-${Date.now()}`);
    const transportStart = mock(async () => {});
    mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {
        start = transportStart;
      },
    }));

    try {
      await startCopilotServer(cwd);
      await expect(fs.stat(path.join(cwd, ".dao"))).resolves.toBeDefined();
      expect(transportStart).toHaveBeenCalled();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a manual-dispatch error from spawnAgent", async () => {
    const adapter = createCopilotHostAdapter("/tmp/dao");
    const result = await adapter.spawnAgent({
      agent: { id: "pm", name: "Product Manager", role: "product" },
      prompt: "do something",
    });
    expect(result.error).toBeDefined();
    expect(result.content).toBe("");
  });
});
