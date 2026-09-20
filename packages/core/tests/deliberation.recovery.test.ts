// Deliberation recovery & delegation gate semantics.
// Issue #160: a failed worker/host must not strand the proposal in
// `deliberating` — the use case rolls back via ABORT_DELIBERATION to `open`.
// Issue #159: the delegation-closed gate consults a persisted cross-process
// in-flight marker, because the in-memory registry is cleared before any
// dao_control can observe it.
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CreateProposalUseCase,
  createInitialState,
  DEFAULT_AGENTS,
  DeliberateProposalUseCase,
  dispatchProposalEvent,
  InitializeDaoUseCase,
  runGates,
  systemClock,
} from "@guyghost/swarm-dao-core";
import { InMemoryDaoStateRepository } from "../src/adapters/persistence/in-memory-dao-state.repository.js";
import { clearDelegationInFlight, markDelegationInFlight } from "../src/governance/delegation.utils.js";
import type { HostAdapter, Proposal } from "../src/types/index.js";

/** A host whose model resolution explodes AFTER the DELIBERATE commit:
 *  models the dead-host/timeout window the rollback guard must cover. */
function brokenHost(): HostAdapter {
  return {
    hostId: "broken-host",
    getSessionModel: () => {
      throw new Error("host session died");
    },
    spawnAgent: async () => {
      throw new Error("tmux host died");
    },
    spawnAgents: async () => [],
    log: async () => {},
    getWorkingDirectory: () => "/repo",
    readFile: async () => "",
    writeFile: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    hasCapability: () => false,
  };
}

describe("deliberation recovery (issue #160)", () => {
  test("a worker failure rolls the proposal back instead of stranding it in deliberating", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/recovery/.dao"));
    await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
    const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
      title: "Doomed",
      type: "product-feature",
      description: "d",
      proposedBy: "test",
    });
    if (!created.ok) throw new Error(created.error);

    const useCase = new DeliberateProposalUseCase({ repository, worker: brokenHost(), clock: systemClock });
    const result = await useCase.execute({ proposalId: created.proposal.id });
    expect(result.ok).toBe(false);

    const stored = repository.get().proposals.find((p) => p.id === created.proposal.id);
    // Not stuck in `deliberating`: ABORT_DELIBERATION returns to open.
    expect(stored?.status).toBe("open");
    expect(repository.get().auditLog.some((e) => e.action === "deliberation_failed")).toBe(true);
  });

  test("ABORT_DELIBERATION returns a deliberating proposal to open for a re-run", () => {
    const proposal: Proposal = {
      id: 1,
      title: "Retry",
      type: "technical-change" as const,
      description: "d",
      proposedBy: "t",
      status: "open" as const,
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
    expect(dispatchProposalEvent(proposal, { type: "DELIBERATE" }).ok).toBe(true);
    expect(proposal.status).toBe("deliberating");
    expect(proposal.deliberationStartedAt).toBeDefined();

    expect(dispatchProposalEvent(proposal, { type: "ABORT_DELIBERATION" })).toMatchObject({
      ok: true,
      status: "open",
    });
    // The proposal can be deliberated again.
    expect(dispatchProposalEvent(proposal, { type: "DELIBERATE" }).ok).toBe(true);
    expect(proposal.status).toBe("deliberating");
  });
});

describe("delegation-closed gate sees the persisted marker (issue #159)", () => {
  const config = {
    ...createInitialState("/tmp/gate/.dao").config,
    requiredGates: ["delegation-closed"],
  };

  function proposal(): Parameters<typeof runGates>[0] {
    return {
      id: 7,
      title: "Delegated",
      type: "technical-change",
      description: "d",
      proposedBy: "t",
      status: "approved",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    };
  }

  test("an in-flight marker on disk blocks the gate even with an empty registry", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "delegation-gate-"));
    try {
      await markDelegationInFlight(daoRoot, 7);
      const result = runGates(proposal(), config, { daoRoot });
      const gate = result.gates.find((g) => g.gateId === "delegation-closed");
      expect(gate?.passed).toBe(false);
      expect(gate?.message).toContain("Delegation in flight");
    } finally {
      await clearDelegationInFlight(daoRoot, 7);
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  test("no marker (or a drained one) lets the gate pass", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "delegation-gate-"));
    try {
      const before = runGates(proposal(), config, { daoRoot });
      expect(before.gates.find((g) => g.gateId === "delegation-closed")?.passed).toBe(true);

      await markDelegationInFlight(daoRoot, 7);
      await clearDelegationInFlight(daoRoot, 7);
      const after = runGates(proposal(), config, { daoRoot });
      expect(after.gates.find((g) => g.gateId === "delegation-closed")?.passed).toBe(true);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  test("a corrupt marker fails CLOSED, not open (review)", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "delegation-gate-"));
    try {
      const marker = path.join(daoRoot, "delegations", "7.in-flight.json");
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, "{half-written", "utf8");
      const result = runGates(proposal(), config, { daoRoot });
      expect(result.gates.find((g) => g.gateId === "delegation-closed")?.passed).toBe(false);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });
});
