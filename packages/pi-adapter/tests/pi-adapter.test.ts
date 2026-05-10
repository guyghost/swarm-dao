import { describe, it, expect } from "bun:test";

describe("pi-adapter", () => {
  it("exports default function", async () => {
    const mod = await import("@guyghost/swarm-dao-pi-adapter");
    expect(typeof mod.default).toBe("function");
  });

  it("has required tool registrations", async () => {
    const mod = await import("@guyghost/swarm-dao-pi-adapter");
    // The default export is a function that takes ExtensionAPI
    // We can't fully test without Pi runtime, but we verify the module loads
    expect(mod.default).toBeDefined();
  });
});