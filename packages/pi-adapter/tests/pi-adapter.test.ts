// ============================================================
// Swarm DAO Pi Adapter — Tests
// ============================================================
// Uses a mock ExtensionAPI to verify tool registration,
// command registration, event handlers, and core interactions.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

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
  // biome-ignore lint/suspicious/noExplicitAny: mock interface for test command handler
  handler: (...args: any[]) => Promise<string | undefined>;
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
  "dao_audit",
  "dao_artefacts",
  "dao_rate",
  "dao_dashboard",
  "dao_dry_run",
  "dao_rollback",
  "dao_roundtable",
  "dao_update_proposal",
];

const DAO_ROOT = path.join(process.cwd(), ".dao");

// ── Test Suite ──────────────────────────────────────────────

describe("swarmDaoExtension", () => {
  let _mockPi: MockPi;

  beforeAll(async () => {
    // Clean up any leftover .dao directory
    try {
      await fs.rm(DAO_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  afterAll(async () => {
    // Clean up .dao directory created by tests
    try {
      await fs.rm(DAO_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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

      const daoCommand = pi.commands.find((c) => c.name === "/dao");
      expect(daoCommand).toBeDefined();
      expect(typeof daoCommand?.handler).toBe("function");
      expect(typeof daoCommand?.description).toBe("string");
    });

    it("/dao command returns uninitialized message when DAO is not set up", async () => {
      const mod = await import("@guyghost/swarm-dao-pi-adapter");
      const pi = createMockPi();
      mod.default(pi);

      const daoCommand = pi.commands.find((c) => c.name === "/dao");
      const result = await daoCommand?.handler("", {});
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

      const daoCommand = pi.commands.find((c) => c.name === "/dao");
      const result = await daoCommand?.handler("", {});
      expect(result).toContain("# Swarm DAO Dashboard");
      expect(result).toContain(`Agents: ${state.agents.length}`);
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

  // ── dao_update_proposal tool ────────────────────────────

  describe("dao_update_proposal tool", () => {
    async function setupDao() {
      const { initStorage, setState, getOrCreateState, initializeAgents } = await import(
        "@guyghost/swarm-dao-core"
      );
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
      const { getProposal, transitionProposal } = await import("@guyghost/swarm-dao-core");
      const pi = await createOpenProposal();

      // Move proposal out of open status
      const proposal = getProposal(1);
      // biome-ignore lint/style/noNonNullAssertion: proposal was just created
      transitionProposal(proposal!, "deliberate");

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
  });
});
