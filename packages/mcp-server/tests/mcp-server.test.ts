import { afterEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetLogHandler, setLogHandler } from "@guyghost/swarm-dao-core";
import { createMcpHostAdapter, createStdioHostAdapter, resolveDaoRoot } from "../src/host-adapter.js";
import { createSwarmDaoMcpServer, ensureDaoStorage } from "../src/server.js";

describe("mcp-server", () => {
  afterEach(() => {
    resetLogHandler();
    mock.restore();
  });

  it("builds a stdio host adapter", () => {
    const adapter = createStdioHostAdapter("mcp", "/tmp/dao");
    expect(adapter.hostId).toBe("mcp");
    expect(adapter.getWorkingDirectory()).toBe("/tmp/dao");
    expect(adapter.hasCapability("read_file")).toBe(true);
  });

  it("createMcpHostAdapter defaults hostId to mcp", () => {
    expect(createMcpHostAdapter("/tmp/dao").hostId).toBe("mcp");
  });

  it("resolveDaoRoot falls back to cwd when DAO_ROOT unset", () => {
    const prev = process.env.DAO_ROOT;
    delete process.env.DAO_ROOT;
    try {
      expect(resolveDaoRoot()).toBe(process.cwd());
    } finally {
      if (prev !== undefined) process.env.DAO_ROOT = prev;
    }
  });

  it("creates a Swarm DAO MCP server", () => {
    const server = createSwarmDaoMcpServer("/tmp/dao");
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  it("ensureDaoStorage initializes DAO storage on disk", async () => {
    const cwd = path.join(tmpdir(), `swarm-mcp-${Date.now()}`);
    try {
      await ensureDaoStorage(cwd);
      const daoRoot = path.join(cwd, ".dao");
      await expect(fs.stat(daoRoot)).resolves.toBeDefined();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("host adapter log routes by severity", async () => {
    const handler = mock(() => {});
    setLogHandler(handler);
    const adapter = createStdioHostAdapter("mcp", "/tmp/dao");

    await adapter.log({ level: "info", service: "test", message: "hello" });
    await adapter.log({ level: "warn", service: "test", message: "careful" });
    await adapter.log({ level: "error", service: "test", message: "broken" });

    expect(handler.mock.calls.map((call) => call[0])).toEqual(["info", "warn", "error"]);
  });

  it("host adapter enforces contained read/write", async () => {
    const root = path.join(tmpdir(), `swarm-mcp-host-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    const adapter = createStdioHostAdapter("mcp", root);

    try {
      await adapter.writeFile("inside.txt", "hello");
      expect(await adapter.readFile("inside.txt")).toBe("hello");
      await expect(adapter.readFile("../outside.txt")).rejects.toThrow("Path traversal denied");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
