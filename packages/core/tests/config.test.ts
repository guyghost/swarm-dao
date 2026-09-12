import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DAOConfig } from "@guyghost/swarm-dao-core";
import {
  canEditWithoutProposal,
  DEFAULT_PROJECT_CONFIG,
  filterEnabledAgents,
  initializeAgents,
  isCriticalPath,
  loadConfig,
  mergeConfig,
  saveConfig,
  shouldSuggestProposal,
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
      defaultModel: "test/model",
      maxConcurrent: 3,
      riskThreshold: 7,
      requiredGates: [],
      typeQuorum: {
        "product-feature": { quorumPercent: 60, approvalThreshold: 55 },
        "security-change": { quorumPercent: 80, approvalThreshold: 70 },
      },
      quorumFloor: 40,
    };
    const merged = mergeConfig(base, {
      typeQuorum: {
        "product-feature": { quorumPercent: 70, approvalThreshold: 55 },
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
