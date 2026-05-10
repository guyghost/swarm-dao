import { describe, it, expect } from "bun:test";
import {
  DEFAULT_PROJECT_CONFIG,
  shouldSuggestProposal,
  isCriticalPath,
  canEditWithoutProposal,
  validateWeights,
  filterEnabledAgents,
} from "@guyghost/swarm-dao-core";
import { initializeAgents } from "@guyghost/swarm-dao-core";

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
  });

  it("allows edits based on mode", () => {
    expect(canEditWithoutProposal("src/ui/button.ts", "opt-in", [], [])).toBe(true);
    expect(canEditWithoutProposal("src/ui/button.ts", "suggest", [], [])).toBe(true);
    expect(canEditWithoutProposal("src/auth/login.ts", "enforce", ["src/auth/**"], [])).toBe(false);
    expect(canEditWithoutProposal("src/auth/login.ts", "enforce", ["src/auth/**"], ["src/auth/**"])).toBe(true);
  });

  it("validates health weights", () => {
    expect(validateWeights({ passRate: 25, avgRating: 25, deliberationDepth: 25, participation: 25 }).valid).toBe(true);
    expect(validateWeights({ passRate: 30, avgRating: 30, deliberationDepth: 30, participation: 30 }).valid).toBe(false);
    expect(validateWeights({ passRate: -5 }).valid).toBe(false);
  });

  it("filters enabled agents", () => {
    const agents = initializeAgents();
    const filtered = filterEnabledAgents(agents, { mode: "opt-in", agentOverrides: { researcher: { enabled: false } } });
    expect(filtered.length).toBe(6);
    expect(filtered.find((a) => a.id === "researcher")).toBeUndefined();
  });
});