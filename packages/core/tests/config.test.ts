import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DAOConfig, ProjectConfig } from "@guyghost/swarm-dao-core";
import {
  CURRENT_CONFIG_VERSION,
  canEditWithoutProposal,
  DEFAULT_PROJECT_CONFIG,
  effectiveConfigVersion,
  filterEnabledAgents,
  initializeAgents,
  isCriticalPath,
  loadConfig,
  mergeConfig,
  migrateProjectConfig,
  saveConfig,
  shouldSuggestProposal,
  upgradeConfig,
  validateWeights,
} from "@guyghost/swarm-dao-core";

describe("config", () => {
  it("has correct defaults", () => {
    expect(DEFAULT_PROJECT_CONFIG.mode).toBe("opt-in");
    expect(DEFAULT_PROJECT_CONFIG.criticalPaths?.length).toBeGreaterThan(0);
  });

  it("detects suggestion triggers", () => {
    expect(shouldSuggestProposal("I want to add a new feature")).toBe(true);
    expect(shouldSuggestProposal("Let's implement dark mode")).toBe(true);
    expect(shouldSuggestProposal("What is the weather?")).toBe(false);
  });

  it("detects critical paths", () => {
    expect(isCriticalPath("src/auth/login.ts", ["src/auth/**"])).toBe(true);
    expect(isCriticalPath("src/ui/button.ts", ["src/auth/**"])).toBe(false);
    expect(isCriticalPath(".env.local", [".env*"])).toBe(true);
    expect(isCriticalPath("xenv.local", [".env*"])).toBe(false);
  });

  it("allows edits based on mode", () => {
    expect(canEditWithoutProposal("src/ui/button.ts", "opt-in", [], [])).toBe(true);
    expect(canEditWithoutProposal("src/ui/button.ts", "suggest", [], [])).toBe(true);
    expect(canEditWithoutProposal("src/auth/login.ts", "enforce", ["src/auth/**"], [])).toBe(false);
    expect(canEditWithoutProposal("src/auth/login.ts", "enforce", ["src/auth/**"], ["src/auth/**"])).toBe(true);
  });

  it("validates health weights", () => {
    expect(validateWeights({ passRate: 25, avgRating: 25, deliberationDepth: 25, participation: 25 }).valid).toBe(true);
    expect(validateWeights({ passRate: 30, avgRating: 30, deliberationDepth: 30, participation: 30 }).valid).toBe(
      false,
    );
    expect(validateWeights({ passRate: -5 }).valid).toBe(false);
  });

  it("filters enabled agents", () => {
    const agents = initializeAgents();
    const filtered = filterEnabledAgents(agents, {
      mode: "opt-in",
      agentOverrides: { researcher: { enabled: false } },
    });
    expect(filtered.length).toBe(7);
    expect(filtered.find((a) => a.id === "researcher")).toBeUndefined();
  });

  it("mergeConfig merges typeQuorum entries by key", () => {
    const base: DAOConfig = {
      quorumPercent: 60,
      approvalThreshold: 55,
      maxConcurrent: 3,
      riskThreshold: 7,
      requiredGates: [],
      typeQuorum: {
        "product-feature": { quorumPercent: 60, approvalPercent: 55, description: "pf" },
        "security-change": { quorumPercent: 80, approvalPercent: 70, description: "sc" },
      },
      quorumFloor: 40,
    };
    const merged = mergeConfig(base, {
      typeQuorum: {
        "product-feature": { quorumPercent: 70, approvalPercent: 55, description: "pf" },
      },
    });
    expect(merged.typeQuorum["product-feature"]?.quorumPercent).toBe(70);
    expect(merged.typeQuorum["security-change"]?.quorumPercent).toBe(80);
    expect(merged.quorumPercent).toBe(60);
  });

  it("loadConfig merges persisted values with defaults", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"));
    try {
      await saveConfig(daoRoot, { mode: "enforce", criticalPaths: ["src/custom/**"] });
      const loaded = await loadConfig(daoRoot);
      expect(loaded.mode).toBe("enforce");
      expect(loaded.criticalPaths).toEqual(["src/custom/**"]);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("loadConfig returns defaults when config file is missing", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"));
    try {
      const loaded = await loadConfig(daoRoot);
      expect(loaded.mode).toBe(DEFAULT_PROJECT_CONFIG.mode);
      expect(loaded.criticalPaths).toEqual(DEFAULT_PROJECT_CONFIG.criticalPaths);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("loadConfig throws on invalid JSON with path", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"));
    try {
      await fs.writeFile(path.join(daoRoot, "config.json"), "{invalid", "utf-8");
      let threw = false;
      try {
        await loadConfig(daoRoot);
      } catch (error) {
        threw = true;
        expect((error as Error).message).toContain("Invalid JSON");
      }
      expect(threw).toBe(true);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("loadConfig throws on invalid mode and strategy", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"));
    try {
      await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ mode: "typo" }), "utf-8");
      await expect(loadConfig(daoRoot)).rejects.toThrow("mode");
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ deliberation: { strategy: "nope" } }),
        "utf-8",
      );
      await expect(loadConfig(daoRoot)).rejects.toThrow("deliberation.strategy");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("loadConfig deep-merges nested execution config", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ execution: { isolation: "worktree" } }),
        "utf-8",
      );
      const loaded = await loadConfig(daoRoot);
      expect(loaded.execution?.isolation).toBe("worktree");
      expect(loaded.mode).toBe("opt-in");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("loadConfig validates timeout and chars bounds", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ tmux: { timeoutMs: 999999999 } }),
        "utf-8",
      );
      await expect(loadConfig(daoRoot)).rejects.toThrow("timeoutMs");
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ deliberation: { charsPerAgent: 5 } }),
        "utf-8",
      );
      await expect(loadConfig(daoRoot)).rejects.toThrow("charsPerAgent");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });
});

describe("config runtime + agentCommands validation (models/agent-runtime.md §8.5)", () => {
  it("loads runtime and tmux.agentCommands sections", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-runtime-"));
    try {
      await saveConfig(daoRoot, {
        mode: "opt-in",
        runtime: { defaultHarness: "codex", harnessModelFlag: { grok: "--model" } },
        tmux: { command: "echo run", agentCommands: { critic: "codex exec" } },
      });
      const loaded = await loadConfig(daoRoot);
      expect(loaded.runtime).toEqual({ defaultHarness: "codex", harnessModelFlag: { grok: "--model" } });
      expect(loaded.tmux?.agentCommands).toEqual({ critic: "codex exec" });
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects an invalid runtime.defaultHarness at load time (E1)", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-runtime-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ runtime: { defaultHarness: "-bad id" } }),
        "utf-8",
      );
      await expect(loadConfig(daoRoot)).rejects.toThrow("runtime.defaultHarness");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects invalid harnessModelFlag keys and values at load time (E5)", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-runtime-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ runtime: { harnessModelFlag: { "BAD KEY": "--model" } } }),
        "utf-8",
      );
      await expect(loadConfig(daoRoot)).rejects.toThrow("harnessModelFlag");
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ runtime: { harnessModelFlag: { grok: "model" } } }),
        "utf-8",
      );
      await expect(loadConfig(daoRoot)).rejects.toThrow("harnessModelFlag");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects non-string or empty tmux.agentCommands values at load time", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-runtime-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ tmux: { command: "x", agentCommands: { critic: "" } } }),
        "utf-8",
      );
      await expect(loadConfig(daoRoot)).rejects.toThrow("agentCommands");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("config schema version", () => {
  it("treats a config without configVersion as legacy v0", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-version-"));
    try {
      await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ mode: "enforce" }), "utf-8");
      const loaded = await loadConfig(daoRoot);
      expect(effectiveConfigVersion(loaded)).toBe(0);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("round-trips an explicit configVersion", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-version-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ configVersion: 1, mode: "opt-in" }),
        "utf-8",
      );
      const loaded = await loadConfig(daoRoot);
      expect(loaded.configVersion).toBe(1);
      expect(effectiveConfigVersion(loaded)).toBe(1);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects a non-integer or negative configVersion at load time", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-version-"));
    try {
      await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ configVersion: 1.5 }), "utf-8");
      await expect(loadConfig(daoRoot)).rejects.toThrow("configVersion");
      await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ configVersion: -1 }), "utf-8");
      await expect(loadConfig(daoRoot)).rejects.toThrow("configVersion");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("migrateProjectConfig stamps the current version (pure)", () => {
    const legacy: ProjectConfig = { mode: "enforce", criticalPaths: ["src/x/**"] };
    const migrated = migrateProjectConfig(legacy);
    expect(migrated.configVersion).toBe(CURRENT_CONFIG_VERSION);
    // input untouched — migration is pure
    expect(legacy.configVersion).toBeUndefined();
    // already-current configs pass through unchanged
    const current = migrateProjectConfig({ ...legacy, configVersion: CURRENT_CONFIG_VERSION });
    expect(current).toEqual({ ...legacy, configVersion: CURRENT_CONFIG_VERSION });
  });

  it("upgradeConfig aligns a legacy file with the current version and is idempotent", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-version-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ mode: "enforce", criticalPaths: ["src/custom/**"] }),
        "utf-8",
      );
      const first = await upgradeConfig(daoRoot);
      expect(first.from).toBe(0);
      expect(first.to).toBe(CURRENT_CONFIG_VERSION);
      const raw = JSON.parse(await fs.readFile(path.join(daoRoot, "config.json"), "utf-8")) as {
        configVersion?: number;
      };
      expect(raw.configVersion).toBe(CURRENT_CONFIG_VERSION);
      // preserved fields survive the upgrade
      const loaded = await loadConfig(daoRoot);
      expect(loaded.mode).toBe("enforce");
      expect(loaded.criticalPaths).toEqual(["src/custom/**"]);
      const second = await upgradeConfig(daoRoot);
      expect(second.from).toBe(CURRENT_CONFIG_VERSION);
      expect(second.to).toBe(CURRENT_CONFIG_VERSION);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("upgradeConfig refuses a config newer than this tool", async () => {
    const daoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-version-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ configVersion: CURRENT_CONFIG_VERSION + 1 }),
        "utf-8",
      );
      await expect(upgradeConfig(daoRoot)).rejects.toThrow("newer than this tool");
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
