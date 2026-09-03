// ============================================================
// Swarm DAO Pi Adapter — Tests
// ============================================================
// Uses a mock ExtensionAPI to verify tool registration,
// command registration, event handlers, and core interactions.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({
    type: "string",
    enum: values,
  }),
}));

// ── Mock ExtensionAPI ───────────────────────────────────────

interface MockTool {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: mock interface for test tool execute
  execute: (...args: any[]) => Promise<any>;
}

interface MockCommand {
  name: string;
  description: string;
  getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string }> | null;
  // biome-ignore lint/suspicious/noExplicitAny: mock interface for test command handler
  handler: (...args: any[]) => Promise<void>;
}

/**
 * Mock command context that captures `/dao` output the way real Pi renders it:
 * `ui.custom` runs the component factory and stores its render(100) lines,
 * `ui.notify` stores the message. `rendered()` returns the joined output.
 */
function createMockCommandContext(): {
  ctx: Record<string, unknown>;
  rendered: () => string;
  notified: () => string;
} {
  let customLines: string[] = [];
  let notifiedMessage = "";
  const ctx = {
    ui: {
      // biome-ignore lint/suspicious/noExplicitAny: mirrors Pi's ui.custom factory contract
      custom: async (factory: any) => {
        const component = await factory({}, {}, {}, () => {});
        customLines = component.render(100) as string[];
      },
      notify: (message: string) => {
        notifiedMessage = message;
      },
    },
  };
  return { ctx, rendered: () => customLines.join("\n"), notified: () => notifiedMessage };
}

interface MockEvent {
  event: string;
  // biome-ignore lint/suspicious/noExplicitAny: mock interface for test event handler
  handler: (...args: any[]) => Promise<any>;
}

interface MockPi {
  registerTool(tool: MockTool): void;
  registerCommand(name: string, command: Omit<MockCommand, "name">): void;
  // biome-ignore lint/suspicious/noExplicitAny: mock interface for test event handler
  on(event: string, handler: (...args: any[]) => Promise<any>): void;
  tools: MockTool[];
  commands: MockCommand[];
  events: MockEvent[];
}

function createMockPi(): MockPi {
  const tools: MockTool[] = [];
  const commands: MockCommand[] = [];
  const events: MockEvent[] = [];
  return {
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, cmd) {
      commands.push({ name, ...cmd });
    },
    on(event, handler) {
      events.push({ event, handler });
    },
    tools,
    commands,
    events,
  };
}

// ── Expected tool names ─────────────────────────────────────

const EXPECTED_TOOLS = [
  "dao_setup",
  "dao_propose",
  "dao_deliberate",
  "dao_check",
  "dao_plan",
  "dao_execute",
  "dao_ship",
  "dao_audit",
  "dao_artefacts",
  "dao_rate",
  "dao_dashboard",
  "dao_dry_run",
  "dao_rollback",
  "dao_reject",
  "dao_roundtable",
  "dao_update_proposal",
  "dao_config_github",
  "dao_github_create_branch",
  "dao_github_open_pr",
  "dao_check_edit",
  "dao_attention",
  "dao_graph_status",
  "dao_graph_submit",
  "dao_product_status",
  "dao_product_submit",
  "dao_improve_status",
  "dao_improve_once",
];

// Tests run against a throwaway git checkout: the tools resolve paths from
// process.cwd(), and under a root-level `bun test` that is the REPOSITORY —
// the cleanup hooks would wipe the repo's real `.dao/` (dogfood-003 c7 lost
// its series worktree exactly this way).
let DAO_ROOT: string;
let testRoot: string;
let cwdBefore: string;

// ── Test Suite ──────────────────────────────────────────────

describe("swarmDaoExtension", () => {
  let _mockPi: MockPi;

  beforeAll(async () => {
    cwdBefore = process.cwd();
    testRoot = await fs.mkdtemp(path.join(tmpdir(), "swarm-pi-tests-"));
    await Bun.$`git init -q`.cwd(testRoot);
    process.chdir(testRoot);
    DAO_ROOT = path.join(testRoot, ".dao");
  });

  afterAll(async () => {
    process.chdir(cwdBefore);
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    _mockPi = createMockPi();
    // Clear any in-memory state from core (module-level `state` variable)
    const { setState } = await import("@guyghost/swarm-dao-core");
    setState(null);
    // Clean .dao directory
    try {
      await fs.rm(DAO_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  afterEach(async () => {
    // Clean .dao directory after each test
    try {
      await fs.rm(DAO_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── Module loads ─────────────────────────────────────────

  describe("module", () => {
    it("exports a default function", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      expect(typeof mod.default).toBe("function");
    });
  });

  // ── Tool registration ────────────────────────────────────

  describe("tool registration", () => {
    beforeAll(async () => {
      const { setState } = await import("@guyghost/swarm-dao-core");
      setState(null);
      try {
        await fs.rm(DAO_ROOT, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    afterAll(async () => {
      try {
        await fs.rm(DAO_ROOT, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("registers all expected tools", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const registeredNames = pi.tools.map((t) => t.name);
      for (const name of EXPECTED_TOOLS) {
        expect(registeredNames).toContain(name);
      }
    });

    it("registers exactly the expected number of tools", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      expect(pi.tools.length).toBe(EXPECTED_TOOLS.length);
    });

    it("dao_attention lists pending gates with their resolution suggestion", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      await fs.mkdir(path.join(DAO_ROOT, "graph-runs", "g1"), { recursive: true });
      await fs.writeFile(
        path.join(DAO_ROOT, "graph-runs", "g1", "snapshot.json"),
        JSON.stringify({
          runId: "g1",
          state: "awaitingApproval",
          status: "active",
          context: { runId: "g1", modelHash: "cafebabe" },
        }),
        "utf8",
      );

      const tool = pi.tools.find((t) => t.name === "dao_attention");
      const result = await tool?.execute("test-id", {});
      const text = (result?.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? "";
      expect(text).toMatch(/pending human gates?/);
      expect(text).toContain("graph-engineering/g1");
      expect(text).toContain("cafebabe");
      expect(text).toContain("swarm-dao approve --run-id g1");
    });

    it("dao_attention rejects an unknown source", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const tool = pi.tools.find((t) => t.name === "dao_attention");
      const result = await tool?.execute("test-id", { sources: ["vibes"] });
      const text = (result?.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? "";
      expect(text).toContain("Invalid source 'vibes'");
    });

    it("dao_graph_submit submits an AI artifact with the ai channel forced", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const tool = pi.tools.find((t) => t.name === "dao_graph_submit");
      const result = await tool?.execute("test-id", {
        runId: "g2",
        type: "MODEL_DRAFTED",
        producer: "claude",
        payload: JSON.stringify({ modelHash: "deadbeef" }),
        evidence: ["evidence/g2/model.md"],
      });
      const text = (result?.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { accepted: boolean; snapshot: { state: string } };
      expect(parsed.accepted).toBe(true);
      expect(parsed.snapshot.state).toBe("modelReview");

      const journal = (await fs.readFile(path.join(DAO_ROOT, "graph-runs", "g2", "journal.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journal[0].signal).toMatchObject({ type: "MODEL_DRAFTED", source: "ai", producer: "claude" });
    });

    it("dao_graph_submit reports invalid payload JSON instead of throwing", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const tool = pi.tools.find((t) => t.name === "dao_graph_submit");
      const result = await tool?.execute("test-id", {
        runId: "g3",
        type: "MODEL_DRAFTED",
        producer: "claude",
        payload: "{not json",
      });
      const text = (result?.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? "";
      expect(text).toContain("Invalid payload JSON");
    });

    it("dao_improve_status reads a fresh series as idle", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const tool = pi.tools.find((t) => t.name === "dao_improve_status");
      const result = await tool?.execute("test-id", { seriesId: "probe" });
      const text = (result?.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? "";
      const snapshot = JSON.parse(text) as { seriesId: string; state: string };
      expect(snapshot.seriesId).toBe("probe");
      expect(snapshot.state).toBe("idle");
    });

    it("dao_improve_once is a no-op for a fresh idle series", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const tool = pi.tools.find((t) => t.name === "dao_improve_once");
      const result = await tool?.execute("test-id", { seriesId: "pi-idle-1" });
      const text = (result?.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { executed: boolean; event: null; stateAfter: string; detail: string };
      expect(parsed.executed).toBe(false);
      expect(parsed.event).toBeNull();
      expect(parsed.stateAfter).toBe("idle");
      expect(parsed.detail).toContain("terminal");
    });

    it("each tool has name, description, and execute function", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      for (const tool of pi.tools) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
        expect(typeof tool.execute).toBe("function");
      }
    });
  });

  // ── Command registration ─────────────────────────────────

  describe("command registration", () => {
    it("registers the /dao command", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      expect(daoCommand).toBeDefined();
      expect(typeof daoCommand?.handler).toBe("function");
      expect(typeof daoCommand?.description).toBe("string");
    });

    it("displays /dao help as a framed panel through ui.custom", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const commandCtx = createMockCommandContext();
      await pi.commands.find((c) => c.name === "dao")?.handler("help", commandCtx.ctx);

      const rendered = commandCtx.rendered();
      // Pi discards handler return values; output must come from ctx.ui.
      expect(rendered).toContain("┌ Swarm DAO ");
      expect(rendered).toContain("│");
      expect(rendered).toContain("# /dao Help");
      expect(rendered).toContain("Press Enter or Esc to close");
    });

    it("falls back to stdout when no ui is available (print/headless mode)", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const writes: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      // biome-ignore lint/suspicious/noExplicitAny: capturing stdout writes in test
      (process.stdout as any).write = (chunk: string) => {
        writes.push(chunk);
        return true;
      };
      try {
        await pi.commands.find((c) => c.name === "dao")?.handler("help", {});
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restoring stdout
        (process.stdout as any).write = originalWrite;
      }
      const output = writes.join("");
      expect(output).toContain("# /dao Help");
      expect(output).toContain("\n");
    });

    it("falls back to stdout when ui.custom resolves without invoking the factory (print mode)", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const writes: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      // biome-ignore lint/suspicious/noExplicitAny: capturing stdout writes in test
      (process.stdout as any).write = (chunk: string) => {
        writes.push(chunk);
        return true;
      };
      try {
        // Mirrors Pi's print mode: ui.custom exists but is a silent no-op that
        // resolves without ever calling the component factory.
        const ctx = {
          ui: {
            // biome-ignore lint/suspicious/noExplicitAny: silent no-op custom
            custom: async (_factory: any) => {},
            notify: (_message: string) => {},
          },
        };
        await pi.commands.find((c) => c.name === "dao")?.handler("help", ctx);
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restoring stdout
        (process.stdout as any).write = originalWrite;
      }
      expect(writes.join("")).toContain("# /dao Help");
    });

    it("falls back to stdout when ui.custom rejects", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const writes: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      // biome-ignore lint/suspicious/noExplicitAny: capturing stdout writes in test
      (process.stdout as any).write = (chunk: string) => {
        writes.push(chunk);
        return true;
      };
      try {
        const ctx = {
          ui: {
            custom: async () => {
              throw new Error("host custom failed");
            },
            notify: (_message: string) => {},
          },
        };
        await pi.commands.find((c) => c.name === "dao")?.handler("help", ctx);
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restoring stdout
        (process.stdout as any).write = originalWrite;
      }
      expect(writes.join("")).toContain("# /dao Help");
    });

    it("completes subcommands for the first token only", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const complete = daoCommand?.getArgumentCompletions;
      expect(typeof complete).toBe("function");

      // Empty prefix → every subcommand (built-ins + registry ids/aliases)
      const all = (complete?.("") ?? []).map((i) => i.value);
      for (const expected of ["help", "setup", "status", "list", "agents", "audit", "propose", "deliberate"]) {
        expect(all).toContain(expected);
      }

      // Prefix filtering
      expect((complete?.("li") ?? []).map((i) => i.value)).toEqual(["list"]);
      // Case-insensitive
      expect((complete?.("LI") ?? []).map((i) => i.value)).toEqual(["list"]);
      // No match → null
      expect(complete?.("zzz")).toBeNull();
      // Beyond the first token (flags, ids…) → no completions
      expect(complete?.("list --status")).toBeNull();
      expect(complete?.("audit 1")).toBeNull();
    });

    it("/dao command returns uninitialized message when DAO is not set up", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("DAO not initialized");
    });

    it("/dao command returns dashboard when DAO is initialized", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("", commandCtx.ctx);
      const result = commandCtx.rendered();
      // Same rendering as the `dao_dashboard` tool (pipeline + health score).
      expect(result).toContain("# 🏛️ DAO Dashboard");
      expect(result).toContain(`**Agents:** ${state.agents.length} active`);
      expect(result).toContain("# 🏥 DAO Health Score");
    });

    it("/dao dashboard health scores agree with configured weights", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      // Three executed proposals with 5★ ratings: passRate=100, avgRating=100,
      // deliberationDepth=0, participation=100.
      state.proposals = [1, 2, 3].map((id) => ({
        id,
        title: `P${id}`,
        type: "product-feature",
        description: "d",
        proposedBy: "t",
        status: "executed",
        votes: [],
        agentOutputs: [],
      })) as never;
      state.outcomes = {
        1: {
          proposalId: 1,
          ratings: [{ proposalId: 1, rater: "a", score: 5, comment: "", ratedAt: "" }],
          metrics: [],
          overallScore: 5,
          status: "tracked",
          createdAt: "",
          updatedAt: "",
        },
        2: {
          proposalId: 2,
          ratings: [{ proposalId: 2, rater: "a", score: 5, comment: "", ratedAt: "" }],
          metrics: [],
          overallScore: 5,
          status: "tracked",
          createdAt: "",
          updatedAt: "",
        },
        3: {
          proposalId: 3,
          ratings: [{ proposalId: 3, rater: "a", score: 5, comment: "", ratedAt: "" }],
          metrics: [],
          overallScore: 5,
          status: "tracked",
          createdAt: "",
          updatedAt: "",
        },
      } as never;
      // Weights that would yield a different score than the 25/25/25/25 defaults.
      state.config.healthWeights = { passRate: 100, avgRating: 0, deliberationDepth: 0, participation: 0 };
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("status", commandCtx.ctx);
      const result = commandCtx.rendered();
      // Overview line and appended score section must agree (100 with these
      // weights — 80 under defaults, which is the pre-fix conflict).
      const overview = result?.match(/\*\*Health:\*\* (\d+)\/100/)?.[1];
      const section = result?.match(/DAO Health Score: (\d+)\/100/)?.[1];
      expect(overview).toBe("100");
      expect(section).toBe("100");
    });

    it("/dao help returns the registry-driven command list", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("help", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("# /dao Help");
      expect(result).toContain("/dao setup");
      expect(result).toContain("/dao propose");
      expect(result).toContain("/dao deliberate");
      expect(result).toContain("/dao ship");
    });

    it("/dao <known command> executes the matching tool logic", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("deliberate 1", commandCtx.ctx);
      const result = commandCtx.rendered();
      // The dispatcher executes the dao_deliberate logic inline — proposal #1
      // does not exist, so the tool-level validation surfaces.
      expect(result).toContain("Proposal #1 not found");
      expect(result).not.toContain("Unknown /dao subcommand");
    });

    it("/dao list renders the proposal list inline", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("list", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("No proposals yet");
    });

    it("/dao control executes the dao_check tool logic (Pi-specific override)", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("control 1", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("Proposal #1 not found");
      expect(result).not.toContain("dao_control");
    });

    it("/dao check alias also executes the dao_check tool logic", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("check 1", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("Proposal #1 not found");
    });

    it("/dao roundtable executes the tool and creates proposals", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents, getState } = await import(
        "@guyghost/swarm-dao-core"
      );
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("roundtable", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("# 🎯 Round Table Results");
      // The slash command mutated state exactly like the dao_roundtable tool.
      expect(getState().proposals.length).toBe(8);
    });

    it("/dao propose executes the propose tool with quoted arguments", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents, getState } = await import(
        "@guyghost/swarm-dao-core"
      );
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler(
        'propose "Fix login flow" product-feature "Users get logged out when SSO expires"',
        commandCtx.ctx,
      );
      const result = commandCtx.rendered();
      expect(result).toContain("# 📋 Proposal Created");
      expect(result).toContain("Fix login flow");
      expect(getState().proposals[0]?.title).toBe("Fix login flow");
    });

    it("/dao propose rejects an invalid proposal type", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler('propose "Bad" not-a-type "desc"', commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("Invalid type");
      expect(result).toContain("Usage:");
    });

    it("/dao ship without a proposal id shows usage", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("ship", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("Usage:");
      expect(result).toContain("/dao ship <proposalId>");
    });

    it("/dao audit <proposalId> scopes the audit trail", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      state.auditLog = [
        {
          id: 1,
          timestamp: "2025-01-01T00:00:00.000Z",
          proposalId: 1,
          layer: "governance",
          action: "action_one",
          actor: "tester",
          details: "p1",
        },
        {
          id: 2,
          timestamp: "2025-01-01T00:00:00.000Z",
          proposalId: 2,
          layer: "governance",
          action: "action_two",
          actor: "tester",
          details: "p2",
        },
      ];
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("audit 1", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("Proposal #1");
      expect(result).toContain("action_one");
      expect(result).not.toContain("action_two");
    });

    it("/dao audit without args shows the full audit log", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      state.auditLog = [
        {
          id: 1,
          timestamp: "2025-01-01T00:00:00.000Z",
          proposalId: 1,
          layer: "governance",
          action: "action_one",
          actor: "tester",
          details: "p1",
        },
      ];
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("audit", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("# DAO Audit Trail");
      expect(result).toContain("action_one");
    });

    it("/dao audit rejects a non-numeric proposal id", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("audit notanumber", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("Invalid proposal ID");
    });

    it("/dao setup initializes DAO when uninitialized", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("setup", commandCtx.ctx);
      const setupResult = commandCtx.rendered();
      expect(setupResult).toContain("# DAO Initialized");

      const statusCtx = createMockCommandContext();
      await daoCommand?.handler("status", statusCtx.ctx);
      const statusResult = statusCtx.rendered();
      expect(statusResult).toContain("# 🏛️ DAO Dashboard");
    });

    it("/dao ship parses cascade/force flags and executes", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("ship 3 --cascade --force", commandCtx.ctx);
      const result = commandCtx.rendered();
      // Flags parsed cleanly, so the tool logic ran (proposal #3 missing).
      expect(result).toContain("Proposal #3 not found");
      expect(result).not.toContain("Unknown flag");
    });

    it("/dao rejects unknown subcommands", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "dao");
      const commandCtx = createMockCommandContext();
      await daoCommand?.handler("unknown", commandCtx.ctx);
      const result = commandCtx.rendered();
      expect(result).toContain("Unknown /dao subcommand");
      expect(result).toContain("/dao help");
    });
  });

  // ── Event handler registration ───────────────────────────

  describe("event handler registration", () => {
    it("registers session_start event handler", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const sessionHandler = pi.events.find((e) => e.event === "session_start");
      expect(sessionHandler).toBeDefined();
      expect(typeof sessionHandler?.handler).toBe("function");
    });

    it("registers before_agent_start event handler", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const agentHandler = pi.events.find((e) => e.event === "before_agent_start");
      expect(agentHandler).toBeDefined();
      expect(typeof agentHandler?.handler).toBe("function");
    });

    it("registers exactly 2 event handlers", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      expect(pi.events.length).toBe(2);
    });
  });

  // ── session_start handler ────────────────────────────────

  describe("session_start handler", () => {
    it("initializes storage and creates state on session start", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const handler = pi.events.find((e) => e.event === "session_start")?.handler;
      await handler({}, {});

      // After session_start, .dao directory should exist
      const stat = await fs.stat(DAO_ROOT);
      expect(stat.isDirectory()).toBe(true);

      // State should be accessible
      const { getState } = await import("@guyghost/swarm-dao-core");
      const state = getState();
      expect(state).toBeDefined();
      expect(state.initialized).toBe(false);
    });

    it("does not reject when state.json is corrupt", async () => {
      // Simulate a corrupt state file: open() rethrows on invalid JSON (only
      // ENOENT is tolerated), so the handler must catch it itself.
      await fs.mkdir(DAO_ROOT, { recursive: true });
      await fs.writeFile(path.join(DAO_ROOT, "state.json"), "{ not valid json", "utf8");

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const handler = pi.events.find((e) => e.event === "session_start")?.handler;
      await expect(handler({}, {})).resolves.toBeUndefined();
    });

    it("deselects a previously opened repository when a reopen fails", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const handler = pi.events.find((e) => e.event === "session_start")?.handler;
      // First open succeeds and selects the core repository.
      await handler({}, {});
      const { getState } = await import("@guyghost/swarm-dao-core");
      expect(() => getState()).not.toThrow();

      // Corrupt the state file: the failed reopen must deselect the stale
      // repository instead of silently serving the previous session's state.
      await fs.writeFile(path.join(DAO_ROOT, "state.json"), "{ not valid json", "utf8");
      await handler({}, {});
      expect(() => getState()).toThrow();
    });
  });

  // ── before_agent_start handler ───────────────────────────

  describe("before_agent_start handler", () => {
    it("appends DAO context to system prompt when DAO is not initialized", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // Simulate what session_start would do: create state so getState() works
      // but leave initialized=false to test the uninitialized path
      const { initStorage, setState, getOrCreateState } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = false;
      setState(state);

      const handler = pi.events.find((e) => e.event === "before_agent_start")?.handler;
      const result = await handler({ systemPrompt: "You are an AI assistant." }, {});

      expect(result).toBeDefined();
      expect(result.systemPrompt).toContain("You are an AI assistant.");
      expect(result.systemPrompt).toContain("Swarm DAO");
      expect(result.systemPrompt).toContain("dao_setup");
    });

    it("does not throw when storage is unavailable", async () => {
      // getState() throws when no repository was opened (e.g. session_start
      // failed on a corrupt state file). The handler must degrade gracefully.
      const { setState } = await import("@guyghost/swarm-dao-core");
      setState(null);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const handler = pi.events.find((e) => e.event === "before_agent_start")?.handler;
      await expect(handler({ systemPrompt: "You are an AI assistant." }, {})).resolves.toBeDefined();
    });

    it("injects an Available tools list that matches the registered tools", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const handler = pi.events.find((e) => e.event === "before_agent_start")?.handler;
      const result = await handler({ systemPrompt: "base" }, {});

      const match = result.systemPrompt.match(/Available tools: (.+)/);
      expect(match).toBeDefined();
      const advertised =
        match?.[1]
          .split(", ")
          .map((s) => s.trim())
          .sort() ?? [];
      const registered = pi.tools.map((t) => t.name).sort();
      expect(advertised).toEqual(registered);
      expect(advertised).not.toContain("dao_verify");
    });

    it("appends agent info and open proposals to system prompt when DAO is initialized", async () => {
      // Set up an initialized state
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");

      const _daoRoot = await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const handler = pi.events.find((e) => e.event === "before_agent_start")?.handler;
      const result = await handler({ systemPrompt: "You are an AI assistant." }, {});

      expect(result).toBeDefined();
      expect(result.systemPrompt).toContain("Swarm DAO Status");
      expect(result.systemPrompt).toContain("Active agents:");
      expect(
        state.agents.forEach((agent) => {
          expect(result.systemPrompt).toContain(agent.name);
        }),
      );
    });
  });

  // ── dao_setup tool ───────────────────────────────────────

  describe("dao_setup tool", () => {
    it("initializes DAO with default agents and returns agent table", async () => {
      // Pre-initialize state so getState() doesn't throw
      const { initStorage, setState, getOrCreateState } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = false;
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const setupTool = pi.tools.find((t) => t.name === "dao_setup")!;
      const result = await setupTool.execute("test-id", {});

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      const text = result.content[0]?.text;
      expect(text).toContain("DAO Initialized");
      expect(text).toContain("| Agent | Weight | Role |");
      expect(text).toContain("Product Strategist");

      // Verify state is now initialized
      const { getState } = await import("@guyghost/swarm-dao-core");
      const updatedState = getState();
      expect(updatedState.initialized).toBe(true);
      expect(updatedState.agents.length).toBeGreaterThan(0);
    });

    it("returns already-initialized message when DAO is already set up", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const setupTool = pi.tools.find((t) => t.name === "dao_setup")!;
      const result = await setupTool.execute("test-id", {});

      expect(result).toBeDefined();
      const text = result.content[0]?.text;
      expect(text).toContain("already initialized");
    });
  });

  // ── dao_propose tool ─────────────────────────────────────

  describe("github tools", () => {
    it("dao_config_github stores the configuration and confirms", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const tool = pi.tools.find((t) => t.name === "dao_config_github")!;
      const result = await tool.execute("test-id", { token: "ghp_test", owner: "acme", repo: "app" });

      const text = result.content[0]?.text;
      expect(text).toContain("GitHub Configured");
      expect(text).toContain("acme/app");
    });

    it("dao_github_create_branch reports clearly when GitHub is not configured", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      state.proposals.push({
        id: state.nextProposalId++,
        title: "Branch Feature",
        type: "product-feature",
        description: "d",
        proposedBy: "pi-test",
        status: "open",
        votes: [],
        agentOutputs: [],
      } as never);
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const tool = pi.tools.find((t) => t.name === "dao_github_create_branch")!;
      const result = await tool.execute("test-id", { proposalId: 1 });

      const text = result.content[0]?.text;
      expect(text).toContain("GitHub not configured");
    });
  });

  describe("dao_propose tool", () => {
    it("rejects proposal creation when DAO is not initialized", async () => {
      // Set up state that exists but is not initialized
      const { initStorage, setState, getOrCreateState } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = false;
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
      const result = await proposeTool.execute("test-id", {
        title: "Test Proposal",
        type: "product-feature",
        description: "A test proposal",
      });

      expect(result).toBeDefined();
      const text = result.content[0]?.text;
      expect(text).toContain("not initialized");
    });

    it("creates a proposal successfully when DAO is initialized", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
      const result = await proposeTool.execute("test-id", {
        title: "Test Proposal",
        type: "product-feature",
        description: "A test proposal description",
      });

      expect(result).toBeDefined();
      const text = result.content[0]?.text;
      expect(text).toContain("Proposal Created");
      expect(text).toContain("#1");
      expect(text).toContain("Test Proposal");
    });

    it("stores affectedPaths on the proposal when provided", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents, getProposal } = await import(
        "@guyghost/swarm-dao-core"
      );
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
      await proposeTool.execute("test-id", {
        title: "Affected Paths Proposal",
        type: "product-feature",
        description: "Testing affected paths",
        affectedPaths: ["packages/core/src/index.ts", "packages/core/src/types.ts"],
      });

      const proposal = getProposal(1);
      expect(proposal).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: accessing dynamic field on proposal
      expect((proposal as any).affectedPaths).toEqual(["packages/core/src/index.ts", "packages/core/src/types.ts"]);
    });

    it("assigns explicit empty array for acceptanceCriteria (not skipped by truthy check)", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents, getProposal } = await import(
        "@guyghost/swarm-dao-core"
      );
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
      await proposeTool.execute("test-id", {
        title: "Empty Criteria Proposal",
        type: "product-feature",
        description: "Testing empty acceptanceCriteria",
        acceptanceCriteria: [],
      });

      const proposal = getProposal(1);
      expect(proposal).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: accessing dynamic field on proposal
      expect((proposal as any).acceptanceCriteria).toEqual([]);
    });

    it("does NOT assign problemStatement when parameter is omitted", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents, getProposal } = await import(
        "@guyghost/swarm-dao-core"
      );
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
      await proposeTool.execute("test-id", {
        title: "No Problem Statement Proposal",
        type: "product-feature",
        description: "Testing omitted problemStatement",
      });

      const proposal = getProposal(1);
      expect(proposal).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: accessing dynamic field on proposal
      expect((proposal as any).problemStatement).toBeUndefined();
    });
  });

  // ── dao_deliberate tool ──────────────────────────────────

  describe("dao_deliberate tool", () => {
    it("produces agent votes instead of failing with unimplemented spawning", async () => {
      const { initStorage, setState, getOrCreateState, initializeAgents, getProposal } = await import(
        "@guyghost/swarm-dao-core"
      );
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
      await proposeTool.execute("test-id", {
        title: "Deliberation Spawn Fix",
        type: "product-feature",
        description: "Verify deliberation receives real agent outputs",
      });

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const deliberateTool = pi.tools.find((t) => t.name === "dao_deliberate")!;
      const result = await deliberateTool.execute("test-id", { proposalId: 1 });
      const text = result.content[0]?.text ?? "";

      expect(text).toContain("Deliberation Complete");
      expect(text).not.toContain("Votes Cast:** 0 /");

      const proposal = getProposal(1);
      expect(proposal?.votes.length).toBeGreaterThan(0);
    });
  });

  // ── dao_update_proposal tool ────────────────────────────

  describe("dao_update_proposal tool", () => {
    async function setupDao() {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = true;
      state.agents = initializeAgents();
      setState(state);
    }

    async function createOpenProposal(): Promise<MockTool> {
      await setupDao();
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // Create an open proposal first
      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
      await proposeTool.execute("test-id", {
        title: "Update Test Proposal",
        type: "product-feature",
        description: "A proposal to update",
        problemStatement: "initial problem",
        acceptanceCriteria: ["initial criterion"],
      });

      return pi;
    }

    it("correctly assigns an empty string to problemStatement (not skipped by truthy check)", async () => {
      const { getProposal } = await import("@guyghost/swarm-dao-core");
      const pi = await createOpenProposal();

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const updateTool = pi.tools.find((t) => t.name === "dao_update_proposal")!;
      await updateTool.execute("test-id", {
        proposalId: 1,
        problemStatement: "",
      });

      const proposal = getProposal(1);
      expect(proposal).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: accessing dynamic field on proposal
      expect((proposal as any).problemStatement).toBe("");
    });

    it("correctly assigns an empty array to acceptanceCriteria (not skipped by truthy check)", async () => {
      const { getProposal } = await import("@guyghost/swarm-dao-core");
      const pi = await createOpenProposal();

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const updateTool = pi.tools.find((t) => t.name === "dao_update_proposal")!;
      await updateTool.execute("test-id", {
        proposalId: 1,
        acceptanceCriteria: [],
      });

      const proposal = getProposal(1);
      expect(proposal).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: accessing dynamic field on proposal
      expect((proposal as any).acceptanceCriteria).toEqual([]);
    });

    it("rejects when proposal does not exist", async () => {
      await setupDao();
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const updateTool = pi.tools.find((t) => t.name === "dao_update_proposal")!;
      const result = await updateTool.execute("test-id", {
        proposalId: 999,
        problemStatement: "updated",
      });

      expect(result).toBeDefined();
      const text = result.content[0]?.text;
      expect(text).toContain("not found");
    });

    it("rejects when proposal is not open", async () => {
      const { getProposal, dispatchProposalEvent } = await import("@guyghost/swarm-dao-core");
      const pi = await createOpenProposal();

      // Move proposal out of open status
      const proposal = getProposal(1);
      // biome-ignore lint/style/noNonNullAssertion: proposal was just created
      dispatchProposalEvent(proposal!, { type: "DELIBERATE" });

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const updateTool = pi.tools.find((t) => t.name === "dao_update_proposal")!;
      const result = await updateTool.execute("test-id", {
        proposalId: 1,
        problemStatement: "updated",
      });

      expect(result).toBeDefined();
      const text = result.content[0]?.text;
      expect(text).toContain("Must be open");
    });
  });

  // ── dao_dashboard tool ───────────────────────────────────

  describe("dao_dashboard tool", () => {
    it("rejects when DAO is not initialized", async () => {
      const { initStorage, setState, getOrCreateState } = await import("@guyghost/swarm-dao-core");
      await initStorage(process.cwd());
      const state = getOrCreateState(process.cwd());
      state.initialized = false;
      setState(state);

      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
      const dashboardTool = pi.tools.find((t) => t.name === "dao_dashboard")!;
      const result = await dashboardTool.execute("test-id", {});

      expect(result).toBeDefined();
      const text = result.content[0]?.text;
      expect(text).toContain("not initialized");
    });

    // ── dao_ship tool ────────────────────────────────────────

    describe("dao_ship tool", () => {
      it("ships a controlled proposal", async () => {
        const { initStorage, setState, getOrCreateState, initializeAgents, getProposal, dispatchProposalEvent } =
          await import("@guyghost/swarm-dao-core");
        await initStorage(process.cwd());
        const state = getOrCreateState(process.cwd());
        state.initialized = true;
        state.agents = initializeAgents();
        setState(state);

        const mod = await import("@guyghost/swarm-dao-pi-adapter");
        const pi = createMockPi();
        mod.default(pi);

        // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
        const proposeTool = pi.tools.find((t) => t.name === "dao_propose")!;
        await proposeTool.execute("test-id", {
          title: "Ship Tool Proposal",
          type: "product-feature",
          description: "Validate dao_ship",
        });

        const proposal = getProposal(1);
        expect(proposal).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: created in previous step
        dispatchProposalEvent(proposal!, { type: "DELIBERATE" });
        // biome-ignore lint/style/noNonNullAssertion: proposal status transition
        dispatchProposalEvent(proposal!, {
          type: "APPROVE",
          tally: {
            proposalId: 1,
            approved: true,
            quorumMet: true,
            totalAgents: 5,
            votingAgents: 5,
            quorumPercent: 100,
            weightedFor: 10,
            weightedAgainst: 0,
            totalVotingWeight: 10,
            approvalScore: 100,
            votes: [],
          },
        });
        // biome-ignore lint/style/noNonNullAssertion: proposal status transition
        dispatchProposalEvent(proposal!, {
          type: "CONTROL_PASS",
          result: {
            proposalId: 1,
            timestamp: new Date().toISOString(),
            allGatesPassed: true,
            blockerCount: 0,
            warningCount: 0,
            gates: [],
            checklist: [],
          },
        });

        // biome-ignore lint/style/noNonNullAssertion: test expects tool to be registered
        const shipTool = pi.tools.find((t) => t.name === "dao_ship")!;
        const result = await shipTool.execute("test-id", { proposalId: 1 });

        expect(result).toBeDefined();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("Ship Complete");
        expect(text).toContain("#1");
        expect(getProposal(1)?.status).toBe("executed");
      });
    });
  });

  describe("pi subprocess safety", () => {
    it("rejects unsafe model identifiers", async () => {
      const { assertSafePiModel } = await import("../src/index.js");
      expect(() => assertSafePiModel("--help")).toThrow("Invalid pi model identifier");
      expect(() => assertSafePiModel("model;rm -rf /")).toThrow("Invalid pi model identifier");
      expect(() => assertSafePiModel("anthropic/claude-3.5-sonnet")).not.toThrow();
    });

    it("rejects prompts containing null bytes", async () => {
      const { assertSafePiPrompt } = await import("../src/index.js");
      expect(() => assertSafePiPrompt("hello\0world")).toThrow("Invalid pi prompt");
    });
  });

  // ── /dao panel rendering (narrow-terminal contract) ────────

  describe("frameDaoPanel", () => {
    it("boxed rows are exactly the viewport width for every width >= 8", async () => {
      const { frameDaoPanel } = await import("../src/index.js");
      const body = "# /dao Help\n".repeat(3) + "a-very-long-unbreakable-word-that-must-hard-split".repeat(3);
      for (const width of [8, 10, 20, 24, 30, 31, 40, 80, 120, 200]) {
        const lines = frameDaoPanel("Swarm DAO", body, width);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(width);
        }
      }
    });

    it("truncates title and close hint instead of overflowing narrow panels", async () => {
      const { frameDaoPanel } = await import("../src/index.js");
      const lines = frameDaoPanel("Swarm DAO", "short body", 24);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(24);
      // 24 cols → inner 20 → the 28-char hint must be truncated, not overflow.
      expect(lines.some((l) => l.includes("Press Enter or Esc to close"))).toBe(false);
      expect(lines.some((l) => l.includes("Press Enter or"))).toBe(true);
    });

    it("falls back to plain wrapped lines below 8 columns", async () => {
      const { frameDaoPanel } = await import("../src/index.js");
      for (const width of [1, 2, 3, 4, 5, 7]) {
        const lines = frameDaoPanel("Swarm DAO", "some body text here", width);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(width);
        }
        expect(lines.join("")).not.toContain("│");
      }
    });
  });
});
