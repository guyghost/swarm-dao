import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addVoteOn,
  createInitialState,
  FileDaoStateRepository,
  InMemoryDaoStateRepository,
  initStorage,
  recordAuditOn,
  sanitizeErrorMessage,
} from "@guyghost/swarm-dao-core";

describe("persistence (instance-owned)", () => {
  it("initStorage creates a dao root", async () => {
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "swarm-persist-"));
    try {
      const root = await initStorage(cwd);
      expect(root.length).toBeGreaterThan(0);
      const stat = await fs.stat(root);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("FileDaoStateRepository open/persist round-trips proposals", async () => {
    const cwd = await fs.mkdtemp(path.join(tmpdir(), "swarm-persist-"));
    try {
      const repository = await FileDaoStateRepository.open(cwd);
      repository.get().initialized = true;
      repository.get().proposals.push({
        id: 1,
        title: "Feature A",
        type: "product-feature",
        description: "d",
        proposedBy: "user",
        status: "open",
        votes: [],
        agentOutputs: [],
        createdAt: new Date().toISOString(),
      });
      repository.get().nextProposalId = 2;
      await repository.persist();

      const reopened = await FileDaoStateRepository.open(cwd);
      expect(reopened.get().proposals[0]?.title).toBe("Feature A");
      expect(reopened.get().nextProposalId).toBe(2);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("addVoteOn records a vote on an open proposal", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/vote"));
    repository.get().initialized = true;
    repository.get().proposals.push({
      id: 1,
      title: "Vote me",
      type: "product-feature",
      description: "d",
      proposedBy: "user",
      status: "open",
      votes: [],
      agentOutputs: [],
      createdAt: new Date().toISOString(),
    });
    const result = await addVoteOn(repository, 1, {
      agentId: "cli-user",
      agentName: "cli-user",
      position: "for",
      reasoning: "looks good",
      weight: 1,
    });
    expect(result).toEqual({ ok: true, replaced: false });
    expect(repository.get().proposals[0]?.votes).toHaveLength(1);
  });

  it("recordAuditOn appends an audit entry", async () => {
    const repository = new InMemoryDaoStateRepository(createInitialState("/tmp/audit"));
    await recordAuditOn(repository, 1, "governance", "vote-cast", "cli-user", "for");
    expect(repository.get().auditLog).toHaveLength(1);
    expect(repository.get().auditLog[0]?.action).toBe("vote-cast");
  });

  it("sanitizeErrorMessage redacts secrets", () => {
    expect(sanitizeErrorMessage("token=secret-value")).toContain("[REDACTED]");
  });
});
