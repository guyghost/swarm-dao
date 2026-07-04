import { describe, expect, it } from "bun:test";
import {
  buildDaoCommandHelp,
  DAO_COMMAND_PHASE_LABEL,
  DAO_COMMAND_PHASE_ORDER,
  DAO_COMMANDS,
  type DaoCommandHost,
  type DaoCommandPhase,
  getDaoCommands,
  getDaoCommandsByPhase,
  resolveDaoCommand,
  suggestDaoCommand,
} from "../src/commands/registry.js";

const ALL_HOSTS: DaoCommandHost[] = ["claude", "pi", "opencode", "mcp", "cli", "copilot", "codex"];
const VALID_PHASES = new Set<DaoCommandPhase>(DAO_COMMAND_PHASE_ORDER);

describe("commands/registry.ts — invariants", () => {
  it("exposes a non-empty registry", () => {
    expect(DAO_COMMANDS.length).toBeGreaterThan(10);
  });

  it("has no duplicate command ids", () => {
    const ids = DAO_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate aliases and no alias colliding with an id", () => {
    const seen = new Set<string>();
    for (const cmd of DAO_COMMANDS) {
      for (const alias of cmd.aliases ?? []) {
        expect(seen.has(alias)).toBe(false);
        expect(DAO_COMMANDS.some((c) => c.id === alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  it("every command has a valid phase, id, and summary", () => {
    for (const cmd of DAO_COMMANDS) {
      expect(cmd.id.length).toBeGreaterThan(0);
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(VALID_PHASES.has(cmd.phase)).toBe(true);
      for (const h of cmd.hosts ?? []) expect(ALL_HOSTS).toContain(h);
    }
  });

  it("declares the lifecycle spine in order", () => {
    const ids = DAO_COMMANDS.map((c) => c.id);
    for (const required of ["setup", "propose", "deliberate", "control", "execute", "ship"]) {
      expect(ids).toContain(required);
    }
  });

  it("keeps LLM-reachable mutating commands behind a deterministic tool (no free-text transitions)", () => {
    const AI_HOSTS: DaoCommandHost[] = ["claude", "copilot", "codex", "opencode", "mcp"];
    for (const cmd of DAO_COMMANDS) {
      const aiReachable = !cmd.hosts || cmd.hosts.some((h) => AI_HOSTS.includes(h));
      if (cmd.mutating && aiReachable) expect(typeof cmd.tool).toBe("string");
    }
  });
});

describe("resolveDaoCommand", () => {
  it("resolves canonical ids", () => {
    expect(resolveDaoCommand("propose")?.id).toBe("propose");
    expect(resolveDaoCommand("deliberate")?.id).toBe("deliberate");
    expect(resolveDaoCommand("PROPOSE")?.id).toBe("propose"); // case-insensitive
  });

  it("resolves aliases", () => {
    expect(resolveDaoCommand("check")?.id).toBe("control");
    expect(resolveDaoCommand("dashboard")?.id).toBe("status");
    expect(resolveDaoCommand("record")?.id).toBe("record-outputs");
  });

  it("returns undefined for unknown input", () => {
    expect(resolveDaoCommand("definitely-not-real")).toBeUndefined();
    expect(resolveDaoCommand("")).toBeUndefined();
  });

  it("respects host filtering (vote is CLI-only)", () => {
    expect(resolveDaoCommand("vote", "claude")).toBeUndefined();
    expect(resolveDaoCommand("vote", "cli")?.id).toBe("vote");
  });
});

describe("getDaoCommands / getDaoCommandsByPhase", () => {
  it("returns all commands when no host given", () => {
    expect(getDaoCommands().length).toBe(DAO_COMMANDS.length);
  });

  it("filters CLI-only commands out of other hosts", () => {
    const claude = getDaoCommands("claude");
    expect(claude.some((c) => c.id === "vote")).toBe(false);
    expect(claude.some((c) => c.id === "show")).toBe(false);
    const cli = getDaoCommands("cli");
    expect(cli.some((c) => c.id === "vote")).toBe(true);
  });

  it("groups exclusively by declared phases", () => {
    const grouped = getDaoCommandsByPhase();
    for (const phase of Object.keys(grouped) as DaoCommandPhase[]) {
      expect(VALID_PHASES.has(phase)).toBe(true);
      for (const cmd of grouped[phase]) expect(cmd.phase).toBe(phase);
    }
  });
});

describe("buildDaoCommandHelp", () => {
  it("renders the workflow header and every phase label", () => {
    const help = buildDaoCommandHelp();
    expect(help).toContain("Workflow: setup");
    for (const label of Object.values(DAO_COMMAND_PHASE_LABEL)) {
      const phase = DAO_COMMAND_PHASE_ORDER.find((p) => DAO_COMMAND_PHASE_LABEL[p] === label);
      if (phase && getDaoCommandsByPhase()[phase].length > 0) {
        expect(help).toContain(label);
      }
    }
  });

  it("includes the core lifecycle commands", () => {
    const help = buildDaoCommandHelp();
    for (const id of ["propose", "deliberate", "control", "execute", "ship"]) {
      expect(help).toContain(`/dao ${id}`);
    }
  });
});

describe("suggestDaoCommand", () => {
  it("suggests the nearest match within edit distance 2", () => {
    const out = suggestDaoCommand("propos");
    expect(out).toContain("propose");
    expect(out.toLowerCase()).toContain("did you mean");
  });

  it("falls back to the generic hint for distant typos", () => {
    const out = suggestDaoCommand("zzzzzzzz");
    expect(out).toContain("/dao help");
    expect(out.toLowerCase()).not.toContain("did you mean");
  });

  it("always echoes the bad input and is non-empty", () => {
    const out = suggestDaoCommand("whatever");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("whatever");
  });
});
