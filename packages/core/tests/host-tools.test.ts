import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type DaoToolContext,
  getState,
  type HostAdapter,
  handleDaoAgents,
  handleDaoList,
  handleDaoPropose,
  handleDaoSetup,
  initStorage,
  setState,
} from "@guyghost/swarm-dao-core";

function createMockAdapter(workDir: string): HostAdapter {
  return {
    hostId: "test",
    async spawnAgent(params) {
      return {
        agentId: params.agent.id,
        agentName: params.agent.name,
        role: params.agent.role,
        content: "manual",
        durationMs: 1,
      };
    },
    async spawnAgents() {
      return [];
    },
    async log() {},
    getWorkingDirectory() {
      return workDir;
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    hasCapability() {
      return true;
    },
  };
}

describe("host-tools", () => {
  let tmpDir: string;
  let ctx: DaoToolContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-host-tools-"));
    setState(null);
    ctx = {
      adapter: createMockAdapter(tmpDir),
      workDir: tmpDir,
      deliberationMode: "manual",
      controlToolName: "dao_control",
    };
  });

  afterEach(async () => {
    setState(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handleDaoSetup initializes agents", async () => {
    const result = await handleDaoSetup(ctx);
    expect(result).toContain("DAO Initialized");
    expect(getState().initialized).toBe(true);
    expect(getState().agents.length).toBe(7);
  });

  it("handleDaoPropose creates a proposal", async () => {
    await handleDaoSetup(ctx);
    const result = await handleDaoPropose({
      title: "Test feature",
      type: "product-feature",
      description: "A test proposal",
    });
    expect(result).toContain("Proposal Created");
    expect(getState().proposals.length).toBe(1);
  });

  it("handleDaoList returns proposals", async () => {
    await handleDaoSetup(ctx);
    await handleDaoPropose({ title: "A", type: "product-feature", description: "d" });
    const list = await handleDaoList();
    expect(list).toContain("#1: A");
  });

  it("handleDaoAgents lists configured agents", async () => {
    await handleDaoSetup(ctx);
    const agents = await handleDaoAgents();
    expect(agents).toContain("Product Strategist");
  });

  it("initStorage creates .dao directory", async () => {
    await initStorage(tmpDir);
    const stat = await fs.stat(path.join(tmpDir, ".dao"));
    expect(stat.isDirectory()).toBe(true);
  });
});
