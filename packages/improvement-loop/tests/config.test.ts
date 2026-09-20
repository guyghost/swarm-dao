import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_BACKED_ANCHORS,
  loadMetricContract,
  loadProjectImprovementConfig,
  type ProjectImprovementConfig,
  validateProjectAnchorCommands,
  workerOptionsFromConfig,
} from "../src/config.js";
import { resolveAnchorCommands } from "../src/orchestrator.js";

const fourAnchors = (override: Record<string, string> = {}): Record<string, string> => {
  const commands: Record<string, string> = {};
  for (const anchor of COMMAND_BACKED_ANCHORS) commands[anchor] = "echo gate";
  return { ...commands, ...override };
};

describe("improvement-loop — per-project config (.dao/improvement.json)", () => {
  it("maps the four command-backed anchors and excludes the machine-recorded pair", () => {
    expect([...COMMAND_BACKED_ANCHORS].sort()).toEqual(
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

describe("worker harvest pacing config (issue #180)", () => {
  const configWithWorker = (worker: unknown): ProjectImprovementConfig => ({
    path: "/tmp/repo/.dao/improvement.json",
    raw: { anchorCommands: {}, worker },
  });

  it("passes harvest pacing fields through to the worker executor options", () => {
    expect(
      workerOptionsFromConfig(
        configWithWorker({
          kind: "pi",
          agentArgs: ["-ne"],
          pollIntervalMs: 15_000,
          stablePolls: 24,
          timeoutMs: 900_000,
        }),
      ),
    ).toEqual({ kind: "pi", agentArgs: ["-ne"], pollIntervalMs: 15_000, stablePolls: 24, timeoutMs: 900_000 });
  });

  it("omits absent fields so executor defaults apply", () => {
    expect(workerOptionsFromConfig(configWithWorker({}))).toEqual({});
    expect(workerOptionsFromConfig(null)).toEqual({});
  });

  it("refuses a non-numeric pacing field instead of silently ignoring it", () => {
    expect(() => workerOptionsFromConfig(configWithWorker({ stablePolls: "24" }))).toThrow(
      /worker\.stablePolls must be a finite number/,
    );
    expect(() => workerOptionsFromConfig(configWithWorker({ timeoutMs: true }))).toThrow(
      /worker\.timeoutMs must be a finite number/,
    );
  });
});

describe("metric contract (issue #142)", () => {
  const writeProject = async (dir: string, body: Record<string, unknown>): Promise<void> => {
    await mkdir(join(dir, ".dao"), { recursive: true });
    await writeFile(join(dir, ".dao/improvement.json"), JSON.stringify(body));
  };

  it("returns null when no metric section is declared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improve-metric-"));
    try {
      await writeProject(dir, { anchorCommands: fourAnchors() });
      expect(await loadMetricContract(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a declared metric contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improve-metric-"));
    try {
      await writeProject(dir, {
        anchorCommands: fourAnchors(),
        metric: { name: "backtest-eval-v2", prompt: "net absolute PnL per eval-v2 run", evidence: "docs/metrics.md" },
      });
      expect(await loadMetricContract(dir)).toEqual({
        name: "backtest-eval-v2",
        prompt: "net absolute PnL per eval-v2 run",
        evidence: "docs/metrics.md",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a half-declared contract (name without prompt would be silent poison)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "improve-metric-"));
    try {
      await writeProject(dir, { anchorCommands: fourAnchors(), metric: { name: "backtest-eval-v2" } });
      expect(loadMetricContract(dir)).rejects.toThrow(/'metric' requires both 'name' and 'prompt'/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
