import { describe, expect, it } from "bun:test";
import { createClaudeHostAdapter, resolveDaoRoot, startClaudeServer } from "../src/index.js";

describe("claude-adapter", () => {
  it("builds a host adapter with hostId claude", () => {
    const adapter = createClaudeHostAdapter("/tmp/dao");
    expect(adapter.hostId).toBe("claude");
    expect(adapter.getWorkingDirectory()).toBe("/tmp/dao");
  });

  it("exposes resolveDaoRoot and startClaudeServer", () => {
    expect(typeof resolveDaoRoot).toBe("function");
    expect(typeof startClaudeServer).toBe("function");
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
