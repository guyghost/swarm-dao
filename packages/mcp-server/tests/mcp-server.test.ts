import { describe, expect, it } from "bun:test";
import { createMcpHostAdapter, createStdioHostAdapter, resolveDaoRoot } from "../src/host-adapter.js";
import { createSwarmDaoMcpServer } from "../src/server.js";

describe("mcp-server", () => {
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
});
