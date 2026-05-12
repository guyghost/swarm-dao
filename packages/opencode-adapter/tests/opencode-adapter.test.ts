import { describe, expect, it } from "bun:test";

describe("opencode-adapter", () => {
  it("exports OpenCodeDAO plugin", async () => {
    const mod = await import("@guyghost/swarm-dao-opencode-adapter");
    expect(mod.OpenCodeDAO).toBeDefined();
  });

  it("exports default", async () => {
    const mod = await import("@guyghost/swarm-dao-opencode-adapter");
    expect(mod.default).toBeDefined();
  });
});
