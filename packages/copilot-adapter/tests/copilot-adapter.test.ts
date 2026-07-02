import { describe, expect, it } from "bun:test";
import { createCopilotHostAdapter, resolveDaoRoot, startCopilotServer } from "../src/index.js";

describe("copilot-adapter", () => {
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
