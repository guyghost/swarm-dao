// Anchor: audit-runtime-scenario — the reference end-to-end ship-audit
// cycle in a scratch directory: challenge → unchanged confirm → execute →
// consume → new challenge; plus the changed-decision re-challenge and the
// human force bypass. Exercises the real machine, fingerprint, gate, and
// filesystem store (no mocks beyond the approving swarm host).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentOutput, HostAdapter } from "@guyghost/swarm-dao-core";
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
import { FsShipAuditStore, InMemoryDaoStateRepository } from "@guyghost/swarm-dao-core/adapters";

const approvingHost: HostAdapter = {
  hostId: "demo",
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

const root = await mkdtemp(path.join(tmpdir(), "shipaudit-demo-"));
try {
  const daoRoot = path.join(root, ".dao");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(daoRoot, { recursive: true });
  await writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ ship: { auditChallenge: true } }));

  const repository = new InMemoryDaoStateRepository(createInitialState(daoRoot));
  await new InitializeDaoUseCase({ repository }).execute({ agents: DEFAULT_AGENTS });
  const created = await new CreateProposalUseCase({ repository, clock: systemClock }).execute({
    title: "Demo Audited Feature",
    type: "product-feature",
    description: "d",
    proposedBy: "demo",
  });
  if (!created.ok) throw new Error(created.error);
  const id = created.proposal.id;

  const deliberate = await new DeliberateProposalUseCase({
    repository,
    worker: approvingHost,
    clock: systemClock,
  }).execute({ proposalId: id });
  if (!deliberate.ok) throw new Error(deliberate.error);
  const control = await new ControlProposalUseCase({ repository, clock: systemClock }).execute({ proposalId: id });
  if (!control.ok) throw new Error(control.error);

  const store = new FsShipAuditStore(root);
  const gate = (force = false) => {
    const proposal = repository.get().proposals.find((p) => p.id === id);
    if (!proposal) throw new Error("missing");
    return evaluateShipAuditChallenge({ proposal, store, challengeEnabled: true, force });
  };

  // 1. First call challenges.
  const first = await gate();
  if (first.proceed) throw new Error("expected AUDIT_REQUIRED on first call");
  console.log(`1. challenge issued → ${first.message.split("\n")[0]}`);

  // 2. Unchanged second call confirms and executes; the spend is consumed.
  const second = await gate();
  if (!second.proceed) throw new Error("expected confirmation on unchanged second call");
  const shipped = await new ShipProposalUseCase({ repository, clock: systemClock }).execute({
    proposalId: id,
    actor: "demo",
  });
  if (!shipped.ok) throw new Error(shipped.error);
  await second.consume?.();
  const snapshot1 = await store.load(id);
  console.log(
    `2. confirmed → executed (status=${repository.get().proposals.find((p) => p.id === id)?.status}), consumed (state=${snapshot1?.state})`,
  );

  // 3. A changed decision re-challenges (fresh cycle, changed fingerprint).
  const proposal = repository.get().proposals.find((p) => p.id === id);
  if (!proposal) throw new Error("missing");
  proposal.description = "changed scope";
  const before = computeShipFingerprint(proposal);
  const third = await gate();
  if (third.proceed) throw new Error("expected re-challenge after change");
  console.log(`3. changed decision → ${third.message.split("\n")[0]} (fingerprint ${before.slice(0, 8)}…)`);
  const snapshot2 = await store.load(id);
  if (snapshot2?.context.challengeCount !== 2) throw new Error("challenge count must be 2");

  // 4. Human force bypasses and is recorded.
  const forced = await gate(true);
  if (!forced.proceed) throw new Error("expected force to proceed");
  const snapshot3 = await store.load(id);
  if (snapshot3?.state !== "bypassed") throw new Error("expected bypassed state");
  console.log(`4. force → bypassed (recorded: ${snapshot3.context.terminalReason})`);

  // 5. The persisted snapshot is durable evidence.
  const persisted = JSON.parse(await readFile(path.join(daoRoot, "ship-audits", `${id}.json`), "utf8"));
  console.log(`5. snapshot persisted at .dao/ship-audits/${id}.json (state=${persisted.state})`);

  console.log("\nship-audit runtime scenario: OK");
} finally {
  await rm(root, { recursive: true, force: true });
}
