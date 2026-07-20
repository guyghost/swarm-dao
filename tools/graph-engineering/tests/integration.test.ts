import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateGraphContract } from "../contract.js";
import { evaluateStopGate } from "../stop-gate.js";

describe("repository Graph Engineering integration", () => {
  it("validates the approved model hash, topology, frozen anchors, and AI authority", async () => {
    const result = await validateGraphContract(process.cwd());

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.modelHash).toBe("0b1400275d7cef099826933c64f361cd26c36029abc7bfd732a92f221c9bc3d9");
  });

  it("blocks a normal Codex stop until the graph reaches an explicit terminal state", () => {
    expect(evaluateStopGate({ state: "verifying" }).continue).toBe(false);
    expect(evaluateStopGate(null).continue).toBe(true);
    for (const state of ["succeeded", "failed", "blocked", "cancelled"]) {
      expect(evaluateStopGate({ state }).continue).toBe(true);
    }
  });

  it("projects the authority boundary into the repository skill and Codex hook", async () => {
    const skill = await readFile(resolve(".agents/skills/graph-engineering/SKILL.md"), "utf8");
    const hooks = JSON.parse(await readFile(resolve(".codex/hooks.json"), "utf8"));

    expect(skill).toMatch(/models\/graph-engineering\.md/);
    expect(skill).toMatch(/must never submit.*source.*human/is);
    expect(skill).toMatch(/Model.*Review.*Implement.*Verify/is);
    expect(hooks.hooks.Stop[0].hooks[0].command).toMatch(/verify-stop\.ts/);
  });
});
