// ============================================================
// Swarm DAO Pi Adapter — spawnAgent default-on tests
// ============================================================
// Real Pi subprocess spawning is the DEFAULT in the pi adapter; canned
// (simulated) output is only a marked fallback. These tests mock
// `node:child_process` to prove which path runs without launching real
// processes: default-on spawn, explicit disable, legacy disable, and the
// marked fallback when a spawn fails.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({
    type: "string",
    enum: values,
  }),
}));

// ── node:child_process mock ─────────────────────────────────

interface SpawnCall {
  cmd: string;
  args: string[];
}

interface FakeExit {
  code: number;
  stderr: string;
}

const spawnCalls: SpawnCall[] = [];
let spawnExit: FakeExit = { code: 0, stderr: "" };
let stdoutFactory: (() => string) | undefined;

function createFakeChild(stdoutText: string, stderrText: string, code: number): EventEmitter {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  // biome-ignore lint/suspicious/noExplicitAny: fake child-process surface
  (child as any).stdout = stdout;
  // biome-ignore lint/suspicious/noExplicitAny: fake child-process surface
  (child as any).stderr = stderr;
  // biome-ignore lint/suspicious/noExplicitAny: fake child-process surface
  (child as any).kill = () => true;
  process.nextTick(() => {
    if (stdoutText.length > 0) stdout.emit("data", Buffer.from(stdoutText));
    if (stderrText.length > 0) stderr.emit("data", Buffer.from(stderrText));
    child.emit("close", code);
  });
  return child;
}

// Only `spawn` is faked (what the adapter uses for Pi agents). Keep real
// `exec`/`execFile` so a leaked mock cannot brick git/worktree suites that
// share the same bun test process. Restore after this file's suite.
mock.module("node:child_process", () => {
  const spawn = (cmd: string, args: string[], options?: Parameters<typeof realChildProcess.spawn>[2]) => {
    if (cmd !== "pi") {
      return realChildProcess.spawn(cmd, args, options);
    }
    spawnCalls.push({ cmd, args });
    return createFakeChild(stdoutFactory ? stdoutFactory() : "", spawnExit.stderr, spawnExit.code);
  };
  return {
    ...realChildProcess,
    spawn,
    default: { ...realChildProcess, spawn },
  };
});

const SPAWNED_OUTPUT_TEMPLATE = (n: number) => `## Suggested Proposal
**Title:** Grounded fix from live spawn #${n}
**Type:** technical-change
**Description:** Cites packages/pi-adapter/src/index.ts — spawn is default-on, fallback is marked simulated.`;

// ── Mock ExtensionAPI (minimal) ─────────────────────────────

interface MockTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function createMockPi() {
  const tools: MockTool[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal ExtensionAPI stub, same approach as pi-adapter.test.ts
  const registerTool = (tool: any) => tools.push(tool);
  // biome-ignore lint/suspicious/noExplicitAny: minimal ExtensionAPI stub
  const pi = { registerTool, registerCommand: () => {}, on: () => {} } as any;
  return { pi, tools };
}

// ── Environment hygiene ─────────────────────────────────────

const ENV_KEYS = ["SWARM_DAO_DISABLE_PI_SPAWN", "SWARM_DAO_ENABLE_PI_SPAWN", "PI_MODEL"] as const;
let savedEnv: Record<string, string | undefined> = {};

// ── Storage isolation (mirrors pi-adapter.test.ts) ──────────

let testRoot: string;
let DAO_ROOT: string;
let cwdBefore: string;

// ── Test Suite ──────────────────────────────────────────────

describe("pi adapter spawnAgent default-on", () => {
  beforeAll(async () => {
    cwdBefore = process.cwd();
    testRoot = await fs.mkdtemp(path.join(tmpdir(), "swarm-pi-spawn-tests-"));
    await Bun.$`git init -q`.cwd(testRoot);
    process.chdir(testRoot);
    DAO_ROOT = path.join(testRoot, ".dao");
  });

  afterAll(async () => {
    process.chdir(cwdBefore);
    await fs.rm(testRoot, { recursive: true, force: true });
    mock.restore();
  });

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];

    spawnCalls.length = 0;
    spawnExit = { code: 0, stderr: "" };
    stdoutFactory = undefined;

    const { setState } = await import("@guyghost/swarm-dao-core");
    setState(null);
    try {
      await fs.rm(DAO_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    try {
      await fs.rm(DAO_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Initialized DAO + registered extension; returns the dao_roundtable runner. */
  async function setupRoundtable(): Promise<{
    run: () => Promise<string>;
    getState: () => Awaited<ReturnType<typeof import("@guyghost/swarm-dao-core")>["getState"]>;
  }> {
    const core = await import("@guyghost/swarm-dao-core");
    await core.initStorage(process.cwd());
    const state = core.getOrCreateState(process.cwd());
    state.initialized = true;
    state.agents = core.initializeAgents();
    core.setState(state);

    const mod = await import("@guyghost/swarm-dao-pi-adapter");
    const { pi, tools } = createMockPi();
    mod.default(pi);

    const run = async (): Promise<string> => {
      const tool = tools.find((t) => t.name === "dao_roundtable");
      if (!tool) throw new Error("dao_roundtable tool not registered");
      const result = await tool.execute("test-call", {}, undefined, undefined, {
        session: { model: "test/session-model" },
      });
      return result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();
    };
    return { run, getState: core.getState };
  }

  it("spawns a real pi subprocess by default (no env vars needed)", async () => {
    let call = 0;
    stdoutFactory = () => SPAWNED_OUTPUT_TEMPLATE(++call);
    const { run, getState } = await setupRoundtable();

    const output = await run();

    // Every agent reached a real subprocess (no `pi` process actually launched).
    expect(spawnCalls.length).toBe(8);
    expect(spawnCalls.every((c) => c.cmd === "pi")).toBe(true);
    // The live output won: no canned content, no simulated marker.
    expect(output).toContain("Grounded fix from live spawn #1");
    expect(output).not.toContain("Improve developer workflow");
    expect(output).not.toContain("Simulated fallback output");
    // Suggestions from real spawns were turned into proposals.
    const grounded = getState().proposals.filter((p) => p.title.startsWith("Grounded fix from live spawn"));
    expect(grounded.length).toBe(8);
  });

  it("SWARM_DAO_DISABLE_PI_SPAWN=1 skips spawning and marks output simulated", async () => {
    process.env.SWARM_DAO_DISABLE_PI_SPAWN = "1";
    const { run, getState } = await setupRoundtable();

    const output = await run();

    expect(spawnCalls.length).toBe(0);
    expect(output).toContain("Simulated fallback output");
    expect(output).toContain("Tighten proposal quality gates");
    // The marker travels into proposals created from simulated suggestions.
    const canned = getState().proposals.filter((p) => p.description.includes("Simulated fallback output"));
    expect(canned.length).toBe(8);
  });

  it("legacy SWARM_DAO_ENABLE_PI_SPAWN=0 still disables spawning", async () => {
    process.env.SWARM_DAO_ENABLE_PI_SPAWN = "0";
    const { run } = await setupRoundtable();

    const output = await run();

    expect(spawnCalls.length).toBe(0);
    expect(output).toContain("Simulated fallback output");
  });

  it("marks output simulated when the subprocess fails", async () => {
    spawnExit = { code: 1, stderr: "pi: model unavailable" };
    const { run, getState } = await setupRoundtable();

    const output = await run();

    expect(spawnCalls.length).toBe(8);
    expect(output).toContain("Simulated fallback output");
    expect(output).toContain("Tighten proposal quality gates");
    const grounded = getState().proposals.filter((p) => p.title.startsWith("Grounded fix from live spawn"));
    expect(grounded.length).toBe(0);
  });
});
