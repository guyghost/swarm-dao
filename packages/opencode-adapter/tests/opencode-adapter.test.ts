import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getState, setState } from "@guyghost/swarm-dao-core";
import { OpenCodeDAO } from "@guyghost/swarm-dao-opencode-adapter";

// ── Helpers ──────────────────────────────────────────────────

/**
 * Build a mock PluginInput with a temporary directory.
 * The OpenCode adapter calls ctx.client.app.log(), ctx.directory, etc.
 */
function createMockCtx(directory: string) {
  // biome-ignore lint/suspicious/noExplicitAny: mock PluginInput
  const ctx: any = {
    directory,
    client: {
      app: {
        // biome-ignore lint/suspicious/noExplicitAny: SDK callback shape
        log: (_params: any) => Promise.resolve(),
      },
    },
  };
  return ctx;
}

/**
 * Initialize the OpenCode plugin, set up storage, and return the plugin tools.
 * The OpenCodeDAO constructor itself calls initStorage, loadState, and getOrCreateState,
 * so state is already available via getState().
 */
async function setupPlugin(tmpDir: string) {
  // Reset module-level state so tests are isolated
  setState(null);
  const ctx = createMockCtx(tmpDir);
  const plugin = await OpenCodeDAO(ctx);
  return { plugin, ctx };
}

describe("opencode-adapter", () => {
  // ── Original module-level tests ───────────────────────────────

  it("exports OpenCodeDAO plugin", async () => {
    const mod = await import("@guyghost/swarm-dao-opencode-adapter");
    expect(mod.OpenCodeDAO).toBeDefined();
  });

  it("exports default", async () => {
    const mod = await import("@guyghost/swarm-dao-opencode-adapter");
    expect(mod.default).toBeDefined();
  });

  // ── P1: Comprehensive tool tests ───────────────────────────

  describe("plugin structure", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `swarm-oc-test-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      setState(null);
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("returns a plugin with a tool property containing all expected tools", async () => {
      const { plugin } = await setupPlugin(testDir);
      expect(plugin).toBeDefined();
      expect(plugin.tool).toBeDefined();

      const expectedTools = [
        "dao_help",
        "dao_setup",
        "dao_propose",
        "dao_record_outputs",
        "dao_control",
        "dao_execute",
        "dao_list",
        "dao_agents",
        "dao_plan",
        "dao_artefacts",
        "dao_dry_run",
        "dao_rollback",
        "dao_dashboard",
        "dao_roundtable",
        "dao_audit",
        "dao_propose_amendment",
      ];

      for (const toolName of expectedTools) {
        expect(plugin.tool[toolName]).toBeDefined();
        expect(typeof plugin.tool[toolName].execute).toBe("function");
      }
    });
  });

  describe("dao_setup", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `swarm-oc-setup-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      setState(null);
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("initializes DAO and returns agent table with 7 agents", async () => {
      const { plugin } = await setupPlugin(testDir);
      // The OpenCodeDAO constructor already initializes state but NOT agents.
      // dao_setup.execute should set state.initialized = true and add agents.
      const result = await plugin.tool.dao_setup.execute({}, { directory: testDir });

      expect(result).toContain("DAO Initialized");
      expect(result).toContain("Agent");

      // Verify state was updated
      const state = getState();
      expect(state.initialized).toBe(true);
      expect(state.agents.length).toBe(7);
    });

    it("dao_help returns onboarding before setup and workflow after setup", async () => {
      const { plugin } = await setupPlugin(testDir);

      const beforeSetup = await plugin.tool.dao_help.execute({}, { directory: testDir });
      expect(beforeSetup).toContain("DAO not initialized");
      expect(beforeSetup).toContain("dao_setup");

      await plugin.tool.dao_setup.execute({}, { directory: testDir });
      const afterSetup = await plugin.tool.dao_help.execute({}, { directory: testDir });
      expect(afterSetup).toContain("# DAO Help");
      expect(afterSetup).toContain("dao_record_outputs");
    });

    it("returns already-initialized message on second call", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      const second = await plugin.tool.dao_setup.execute({}, { directory: testDir });
      expect(second).toContain("already initialized");
      expect(second).toContain("7 agents");
    });
  });

  describe("dao_propose (bug fix verification)", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `swarm-oc-propose-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      setState(null);
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("creates a new proposal and returns confirmation with id, title, type, and risk zone", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      const result = await plugin.tool.dao_propose.execute(
        {
          title: "Add dark mode",
          type: "product-feature",
          description: "Add dark mode support to the application",
        },
        { directory: testDir },
      );

      // After the bug fix, the result should confirm proposal creation
      // (NOT "Proposal #undefined not found")
      expect(result).not.toContain("not found");
      expect(result).toContain("#1");
      expect(result).toContain("Add dark mode");
      expect(result).toContain("product-feature");
      // Should contain risk zone info (orange for product-feature)
      expect(result).toMatch(/orange|green|red/i);
    });

    it("should NOT require proposalId (bug: old code reads args.proposalId)", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      // The key bug was that dao_propose called getProposal(args.proposalId)
      // A correct implementation should NOT need a proposalId — it creates one.
      const result = await plugin.tool.dao_propose.execute(
        {
          title: "Bug Fix Test",
          type: "product-feature",
          description: "Verify no proposalId needed",
        },
        { directory: testDir },
      );

      // Should succeed and return confirmation (not "Proposal #undefined not found")
      expect(result).not.toContain("not found");
      expect(result).toContain("Bug Fix Test");
    });

    it("sets optional fields when provided", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      const result = await plugin.tool.dao_propose.execute(
        {
          title: "With extras",
          type: "technical-change",
          description: "A technical change",
          context: "Refactoring the auth module",
          problemStatement: "Current auth is monolithic",
          acceptanceCriteria: ["Tests pass", "No regressions"],
          successMetrics: ["Reduced bundle size by 20%"],
          affectedPaths: ["src/auth/"],
        },
        { directory: testDir },
      );

      expect(result).not.toContain("not found");
      expect(result).toContain("With extras");
      expect(result).toContain("technical-change");
    });

    it("returns error when DAO not initialized", async () => {
      const { plugin } = await setupPlugin(testDir);
      // Do NOT call dao_setup — but OpenCodeDAO constructor calls getOrCreateState
      // which sets initialized=false. We need to explicitly mark initialized=false
      // and NOT call dao_setup.
      const state = getState();
      state.initialized = false;

      const result = await plugin.tool.dao_propose.execute(
        { title: "Should fail", type: "product-feature", description: "test" },
        { directory: testDir },
      );

      expect(result).toContain("not initialized");
    });

    it("assigns risk zone based on proposal type", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      // Security changes should be classified as red
      const secResult = await plugin.tool.dao_propose.execute(
        {
          title: "Add OAuth2",
          type: "security-change",
          description: "Implement OAuth2 authentication flow",
        },
        { directory: testDir },
      );
      expect(secResult).not.toContain("not found");
      expect(secResult).toMatch(/red/i);
    });
  });

  describe("dao_list", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `swarm-oc-list-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      setState(null);
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("returns 'no proposals' message when empty", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      const result = await plugin.tool.dao_list.execute({}, {});
      expect(result).toContain("No proposals");
    });

    it("lists proposals after creating one", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });
      await plugin.tool.dao_propose.execute(
        { title: "Listed Feature", type: "product-feature", description: "test" },
        { directory: testDir },
      );

      const result = await plugin.tool.dao_list.execute({}, {});
      expect(result).toContain("Listed Feature");
      expect(result).toContain("#1");
    });

    it("returns error when DAO not initialized", async () => {
      const { plugin } = await setupPlugin(testDir);
      const state = getState();
      state.initialized = false;

      const result = await plugin.tool.dao_list.execute({}, {});
      expect(result).toContain("not initialized");
    });
  });

  describe("dao_agents", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `swarm-oc-agents-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      setState(null);
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("lists agents after setup", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      const result = await plugin.tool.dao_agents.execute({}, {});
      expect(result).toContain("DAO Agents");
      expect(result).toContain("Agent");
      expect(result).toContain("Weight");
      expect(result).toContain("Role");
    });

    it("returns error when DAO not initialized", async () => {
      const { plugin } = await setupPlugin(testDir);
      const state = getState();
      state.initialized = false;

      const result = await plugin.tool.dao_agents.execute({}, {});
      expect(result).toContain("not initialized");
    });
  });

  describe("dao_dashboard", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = path.join(tmpdir(), `swarm-oc-dash-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      setState(null);
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("returns dashboard string with overview and health", async () => {
      const { plugin } = await setupPlugin(testDir);
      await plugin.tool.dao_setup.execute({}, { directory: testDir });

      const result = await plugin.tool.dao_dashboard.execute({}, {});
      expect(result).toContain("DAO Dashboard");
      expect(result).toContain("Health Score");
    });

    it("returns error when DAO not initialized", async () => {
      const { plugin } = await setupPlugin(testDir);
      const state = getState();
      state.initialized = false;

      const result = await plugin.tool.dao_dashboard.execute({}, {});
      expect(result).toContain("not initialized");
    });
  });
});
