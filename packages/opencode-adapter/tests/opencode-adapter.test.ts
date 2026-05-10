import { describe, it, expect } from "bun:test";

describe("opencode-adapter", () => {
  it("exports OpenCodeDAO plugin", async () => {
    const mod = await import("@swarm-dao/opencode-adapter");
    expect(mod.OpenCodeDAO).toBeDefined();
  });

  it("exports default", async () => {
    const mod = await import("@swarm-dao/opencode-adapter");
    expect(mod.default).toBeDefined();
  });
});