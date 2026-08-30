// Wiring contract: the ship handler must gate dao_ship behind the audit
// challenge exactly as the approved model specifies (models/ship-audit.md).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ControlProposalUseCase,
  CreateProposalUseCase,
  computeShipFingerprint,
  createInitialState,
  DEFAULT_AGENTS,
  DeliberateProposalUseCase,
  evaluateShipAuditChallenge,
  InitializeDaoUseCase,
  ShipProposalUseCase,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { InMemoryDaoStateRepository } from "../src/adapters/persistence/in-memory-dao-state.repository.js";
import { FsShipAuditStore } from "../src/adapters/ship-audit/fs-ship-audit.store.js";
import type { DaoToolContext } from "../src/host-tools/handlers.js";
import { handleDaoShip } from "../src/host-tools/handlers.js";
import type { AgentOutput, HostAdapter } from "../src/types/index.js";

const approvingHost: HostAdapter = {
  hostId: "wiring",
  spawnAgent: async ({ agent }): Promise<AgentOutput> => ({
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    content: "## Analysis\na\n## Vote\nfor\n## Reasoning\nr",
    durationMs: 0,
  }),
  spawnAgents: async () => [],
  log: async () => {},
  getWorkingDirectory: () => "/repo",
  readFile: async () => "",
  writeFile: async () => {},
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  hasCapability: () => true,
};

describe("ship-audit wiring", () => {
  let daoRoot: string;
  let repository: InMemoryDaoStateRepository;
  let proposalId: number;

  beforeEach(async () => {
    daoRoot = path.join(await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-ships-")), ".dao");
    await fs.mkdir(daoRoot, { recursive: true });
    await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ ship: { auditChallenge: true } }));
    repository = new InMemoryDaoStateRepository(createInitialState(daoRoot));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
    const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "Audited Feature",
      type: "product-feature",
      description: "d",
      proposedBy: "test",
    });
    if (!created.ok) throw new Error(created.error);
    const deliberation = await new DeliberateProposalUseCase({
      repository,
      worker: approvingHost,
      clock: systemClock,
    }).execute({ proposalId: created.proposal.id });
    if (!deliberation.ok) throw new Error(deliberation.error);
    const control = await new ControlProposalUseCase({ repository, clock: systemClock }).execute({
      proposalId: created.proposal.id,
    });
    if (!control.ok) throw new Error(control.error);
    proposalId = created.proposal.id;
  });

  afterEach(async () => {
    await fs.rm(path.dirname(daoRoot), { recursive: true, force: true });
  });

  async function gate(force = false) {
    const proposal = repository.get().proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error("proposal missing");
    return evaluateShipAuditChallenge({
      proposal,
      store: new FsShipAuditStore(path.dirname(daoRoot)),
      challengeEnabled: true,
      force,
      forceReason: force ? "operator override" : undefined,
    });
  }

  test("INV-1: first call is challenged, nothing executes", async () => {
    const decision = await gate();
    expect(decision.proceed).toBe(false);
    if (decision.proceed) return;
    expect(decision.message).toContain("AUDIT_REQUIRED");
    expect(decision.message).toContain("#1");
    // The proposal has NOT been executed.
    expect(repository.get().proposals.find((p) => p.id === proposalId)?.status).toBe("controlled");
  });

  test("INV-2: an unchanged second call proceeds, and the spend is consumed", async () => {
    await gate();
    const second = await gate();
    expect(second.proceed).toBe(true);
    // The ship itself runs and the confirmation is spent.
    const shipped = await new ShipProposalUseCase({ repository, clock: systemClock }).execute({
      proposalId,
      actor: "test",
    });
    expect(shipped.ok).toBe(true);
    await second.consume?.();
    // A third call after consumption challenges again (INV-6).
    const third = await gate();
    expect(third.proceed).toBe(false);
  });

  test("INV-2: a changed decision re-challenges", async () => {
    await gate();
    const proposal = repository.get().proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error("missing");
    const before = computeShipFingerprint(proposal);
    proposal.description = "changed mid-flight";
    expect(computeShipFingerprint(proposal)).not.toBe(before);
    const second = await gate();
    expect(second.proceed).toBe(false);
    if (second.proceed) return;
    expect(second.message).toContain("challenge 2");
  });

  test("N6: force bypasses and is recorded", async () => {
    await gate();
    const forced = await gate(true);
    expect(forced.proceed).toBe(true);
    const store = new FsShipAuditStore(path.dirname(daoRoot));
    const snapshot = await store.load(proposalId);
    expect(snapshot?.state).toBe("bypassed");
  });

  test("N1: the challenge disabled is a no-op that still proceeds", async () => {
    const proposal = repository.get().proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error("missing");
    const decision = await evaluateShipAuditChallenge({
      proposal,
      store: new FsShipAuditStore(path.dirname(daoRoot)),
      challengeEnabled: false,
    });
    expect(decision.proceed).toBe(true);
  });

  test("handleDaoShip honors the audit challenge from the project config", async () => {
    const ctx: DaoToolContext = {
      adapter: approvingHost,
      workDir: path.dirname(daoRoot),
      deliberationMode: "auto",
      controlToolName: "dao_check",
      repository,
    };
    // First call: challenged, nothing executes.
    const first = await handleDaoShip(ctx, proposalId);
    expect(first).toContain("AUDIT_REQUIRED");
    expect(repository.get().proposals.find((p) => p.id === proposalId)?.status).toBe("controlled");
    // Second call, unchanged: executes through the real use-case.
    const second = await handleDaoShip(ctx, proposalId);
    expect(second).toContain("Shipped");
    expect(repository.get().proposals.find((p) => p.id === proposalId)?.status).toBe("executed");
  });

  test("the fingerprint covers decision-relevant content deterministically", async () => {
    const proposal = repository.get().proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error("missing");
    const fp = computeShipFingerprint(proposal);
    expect(fp).toBe(computeShipFingerprint(proposal));
    expect(fp).toHaveLength(64);
    // A new vote changes the fingerprint.
    proposal.votes.push({
      agentId: "extra",
      agentName: "Extra",
      position: "against",
      reasoning: "r",
      weight: 1,
    });
    expect(computeShipFingerprint(proposal)).not.toBe(fp);
  });
});
