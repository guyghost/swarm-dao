import { describe, expect, it } from "bun:test";
import { createCodexHostAdapter, resolveDaoRoot, startCodexServer } from "../src/index.js";

describe("codex-adapter", () => {
  it("builds a host adapter with hostId codex", () => {
    const adapter = createCodexHostAdapter("/tmp/dao");
    expect(adapter.hostId).toBe("codex");
    expect(adapter.getWorkingDirectory()).toBe("/tmp/dao");
  });

  it("exposes resolveDaoRoot and startCodexServer", () => {
    expect(typeof resolveDaoRoot).toBe("function");
    expect(typeof startCodexServer).toBe("function");
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
