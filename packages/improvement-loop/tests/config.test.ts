import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_BACKED_ANCHORS, loadProjectImprovementConfig, validateProjectAnchorCommands } from "../src/config.js";
import { resolveAnchorCommands } from "../src/orchestrator.js";

const fourAnchors = (override: Record<string, string> = {}): Record<string, string> => {
  const commands: Record<string, string> = {};
  for (const anchor of COMMAND_BACKED_ANCHORS) commands[anchor] = "echo gate";
  return { ...commands, ...override };
};

describe("improvement-loop — per-project config (.dao/improvement.json)", () => {
  it("maps the four command-backed anchors and excludes the machine-recorded pair", () => {
    expect(COMMAND_BACKED_ANCHORS.sort()).toEqual(
      ["anchor-reality", "drift-audit", "frozen-set-intact", "regression"].sort(),
    );
  });

  it("accepts exactly the command-backed anchors with non-empty commands", () => {
    const validated = validateProjectAnchorCommands(fourAnchors({ regression: "npm test" }));
    expect(validated.regression).toBe("npm test");
  });

  it("rejects missing, unknown, and machine-recorded anchors", () => {
    expect(() => validateProjectAnchorCommands({})).toThrow(/missing command for required anchor/);
    expect(() => validateProjectAnchorCommands(fourAnchors({ "bogus-anchor": "echo x" }))).toThrow(
      /'bogus-anchor' is not a required improvement anchor/,
    );
    expect(() => validateProjectAnchorCommands(fourAnchors({ "counter-metric-paired": "echo x" }))).toThrow(
      /recorded automatically by the machine/,
    );
    expect(() => validateProjectAnchorCommands(fourAnchors({ regression: "  " }))).toThrow(
      /must be bound to a non-empty command string/,
    );
  });

  it("returns null when the config file is absent and throws when it is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improve-config-"));
    try {
      expect(await loadProjectImprovementConfig(dir)).toBeNull();

      await mkdir(join(dir, ".dao"), { recursive: true });
      await writeFile(join(dir, ".dao/improvement.json"), "{ not json");
      expect(loadProjectImprovementConfig(dir)).rejects.toThrow(/not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves project anchor commands from .dao/improvement.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improve-resolve-"));
    try {
      const commands = fourAnchors({ "anchor-reality": "make verify" });
      await mkdir(join(dir, ".dao"), { recursive: true });
      await writeFile(
        join(dir, ".dao/improvement.json"),
        JSON.stringify({ anchorCommands: commands, sandbox: { mode: "docker", image: "node:22" } }),
      );
      const resolved = await resolveAnchorCommands(dir);
      expect(Object.fromEntries(resolved)).toEqual(commands);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails with guidance when no anchor configuration exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improve-empty-"));
    try {
      expect(resolveAnchorCommands(dir)).rejects.toThrow(/improvement-loop\.graph\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
