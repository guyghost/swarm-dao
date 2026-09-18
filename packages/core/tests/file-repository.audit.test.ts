import { beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuditEntry, Proposal } from "@guyghost/swarm-dao-core";
import { FileDaoStateRepository } from "@guyghost/swarm-dao-core";

let workDir: string;

function proposal(id: number, status: Proposal["status"]): Proposal {
  return {
    id,
    title: `Proposal #${id}`,
    type: "product-feature",
    description: "d",
    problemStatement: "p",
    acceptanceCriteria: [],
    successMetrics: [],
    rollbackConditions: [],
    proposedBy: "tester",
    status,
    votes: [],
    agentOutputs: [],
    createdAt: "2031-01-01T00:00:00.000Z",
  };
}

function audit(id: number, action = "vote_cast"): AuditEntry {
  return {
    id,
    timestamp: "2031-01-01T00:00:00.000Z",
    proposalId: (id % 5) + 1,
    layer: "governance",
    action,
    actor: "tester",
    details: `entry ${id}`,
  };
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-audit-"));
});

describe("file repository audit JSONL (ADR-005)", () => {
  it("writes audit entries to audit.jsonl instead of state.json", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().auditLog.push(audit(1), audit(2));
    await repository.persist();

    const live = JSON.parse(await fs.readFile(path.join(workDir, ".dao", "state.json"), "utf8"));
    expect(live.auditLog).toEqual([]);

    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().auditLog.map((e) => e.id)).toEqual([1, 2]);
    expect(reopened.get().auditLog[0]?.details).toBe("entry 1");
  });

  it("deduplicates entries re-appended after a crash (id unique on load)", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().auditLog.push(audit(1));
    await repository.persist();

    const jsonlPath = path.join(workDir, ".dao", "audit.jsonl");
    const raw = await fs.readFile(jsonlPath, "utf8");
    await fs.writeFile(jsonlPath, raw + raw); // simulate double-append

    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().auditLog).toHaveLength(1);
  });

  it("tolerates a torn trailing line from a mid-append crash", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().auditLog.push(audit(1), audit(2));
    await repository.persist();

    const jsonlPath = path.join(workDir, ".dao", "audit.jsonl");
    const raw = await fs.readFile(jsonlPath, "utf8");
    await fs.writeFile(jsonlPath, `${raw}{"id":3,"torn`);

    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().auditLog.map((e) => e.id)).toEqual([1, 2]);
  });

  it("appends without rewriting: existing file content is a strict prefix", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().auditLog.push(audit(1));
    await repository.persist();
    const jsonlPath = path.join(workDir, ".dao", "audit.jsonl");
    const before = await fs.readFile(jsonlPath, "utf8");

    repository.get().auditLog.push(audit(2));
    await repository.persist();

    const after = await fs.readFile(jsonlPath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().auditLog.map((e) => e.id)).toEqual([1, 2]);
  });

  it("migrates legacy inline auditLog to the JSONL on the first writing persist", async () => {
    const daoDir = path.join(workDir, ".dao");
    await fs.mkdir(daoDir, { recursive: true });
    await fs.writeFile(
      path.join(daoDir, "state.json"),
      JSON.stringify({
        initialized: true,
        daoRoot: daoDir,
        nextProposalId: 1,
        nextAuditId: 3,
        stateRevision: 1,
        proposals: [],
        auditLog: [audit(1), audit(2)],
      }),
    );

    // Read-only load sees the inline trail without writing anything.
    const repository = await FileDaoStateRepository.open(workDir);
    expect(repository.get().auditLog).toHaveLength(2);
    await fs.access(path.join(daoDir, "audit.jsonl")).then(
      () => expect.unreachable("audit.jsonl must not exist before a write"),
      () => undefined,
    );

    await repository.persist();
    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().auditLog.map((e) => e.id)).toEqual([1, 2]);
    const live = JSON.parse(await fs.readFile(path.join(daoDir, "state.json"), "utf8"));
    expect(live.auditLog).toEqual([]);
  });

  it("repairs nextAuditId past the JSONL max id after a backup restore", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().auditLog.push(audit(900));
    repository.get().nextAuditId = 901;
    await repository.persist();

    const daoDir = path.join(workDir, ".dao");
    const state = JSON.parse(await fs.readFile(path.join(daoDir, "state.json"), "utf8"));
    state.nextAuditId = 2; // restored old counter
    await fs.writeFile(path.join(daoDir, "state.json"), JSON.stringify(state, null, 2));

    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().nextAuditId).toBeGreaterThan(900);
  });

  it("keeps a no-op persist byte-identical across state.json and audit.jsonl", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().auditLog.push(audit(1));
    await repository.persist();

    const statePath = path.join(workDir, ".dao", "state.json");
    const jsonlPath = path.join(workDir, ".dao", "audit.jsonl");
    const stateBefore = await fs.readFile(statePath, "utf8");
    const jsonlBefore = await fs.readFile(jsonlPath, "utf8");

    await repository.persist();
    await repository.persist();

    expect(await fs.readFile(statePath, "utf8")).toBe(stateBefore);
    expect(await fs.readFile(jsonlPath, "utf8")).toBe(jsonlBefore);
  });

  it("keeps the loadState compat path on the merged trail", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().auditLog.push(audit(1));
    await repository.persist();

    const { loadState } = await import("@guyghost/swarm-dao-core");
    const loaded = await loadState(workDir);
    expect(loaded?.auditLog.map((e) => e.id)).toEqual([1]);
  });
});
