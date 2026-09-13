import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileDaoStateRepository } from "@guyghost/swarm-dao-core";

async function mkRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "swarm-file-repo-"));
}

describe("FileDaoStateRepository concurrency", () => {
  it("serializes concurrent persist() and leaves no tmp/lock residue", async () => {
    const cwd = await mkRoot();
    try {
      const repo = await FileDaoStateRepository.open(cwd);
      repo.get().initialized = true;
      await Promise.all([repo.persist(), repo.persist(), repo.persist()]);
      const daoRoot = path.join(cwd, ".dao");
      const entries = await fs.readdir(daoRoot);
      expect(entries).not.toContain("state.lock");
      expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
      const reloaded = await FileDaoStateRepository.open(cwd);
      expect(reloaded.get().initialized).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite proposals persisted by another writer", async () => {
    const cwd = await mkRoot();
    try {
      const a = await FileDaoStateRepository.open(cwd);
      a.get().initialized = true;
      await a.persist();

      const b = await FileDaoStateRepository.open(cwd);
      // A creates proposal #1 and persists.
      a.get().proposals.push({
        id: 1,
        title: "From A",
        type: "technical-change",
        description: "d",
        proposedBy: "a",
        status: "open",
        votes: [],
        agentOutputs: [],
        createdAt: "2031-01-01T00:00:00.000Z",
      } as never);
      a.get().nextProposalId = 2;
      await a.persist();

      // B still has empty memory: persisting must fail fast, not drop #1.
      await expect(b.persist()).rejects.toThrow("Concurrent modification");
      const reloaded = await FileDaoStateRepository.open(cwd);
      expect(reloaded.get().proposals.map((p) => p.id)).toEqual([1]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("cleans a stale lock file", async () => {
    const cwd = await mkRoot();
    try {
      const repo = await FileDaoStateRepository.open(cwd);
      const daoRoot = path.join(cwd, ".dao");
      await fs.mkdir(daoRoot, { recursive: true });
      await fs.writeFile(
        path.join(daoRoot, "state.lock"),
        JSON.stringify({ pid: 999999, ts: Date.now() - 60000 }),
        "utf8",
      );
      await repo.persist();
      const entries = await fs.readdir(daoRoot);
      expect(entries).not.toContain("state.lock");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("detects votes added by another writer through the state revision (issue #153)", async () => {
    const cwd = await mkRoot();
    try {
      const a = await FileDaoStateRepository.open(cwd);
      a.get().initialized = true;
      a.get().proposals.push({
        id: 1,
        title: "Shared",
        type: "technical-change",
        description: "d",
        proposedBy: "a",
        status: "deliberating",
        votes: [],
        agentOutputs: [],
        createdAt: "2031-01-01T00:00:00.000Z",
      } as never);
      a.get().nextProposalId = 2;
      await a.persist();

      const b = await FileDaoStateRepository.open(cwd);
      // B votes on the proposal KNOWN to both processes and persists.
      b.get().proposals[0]?.votes.push({
        agentId: "voter-b",
        agentName: "B",
        position: "for",
        reasoning: "ok",
        weight: 1,
      });
      await b.persist();

      // A's stale copy adds a different vote: proposal ids and nextProposalId
      // are unchanged, so only the revision counter can catch this. Persisting
      // must fail instead of silently dropping B's vote.
      a.get().proposals[0]?.votes.push({
        agentId: "voter-a",
        agentName: "A",
        position: "against",
        reasoning: "ok",
        weight: 1,
      });
      await expect(a.persist()).rejects.toThrow("Concurrent modification");

      const reloaded = await FileDaoStateRepository.open(cwd);
      expect(reloaded.get().proposals[0]?.votes.map((v) => v.agentId)).toEqual(["voter-b"]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("repairs ID counters from the maximum existing ids on open (issue #157)", async () => {
    const cwd = await mkRoot();
    try {
      const daoRoot = path.join(cwd, ".dao");
      await fs.mkdir(daoRoot, { recursive: true });
      const state = {
        daoRoot,
        initialized: true,
        nextProposalId: 2,
        nextAuditId: 3,
        proposals: [1, 2, 42].map((id) => ({
          id,
          title: `P${id}`,
          type: "technical-change",
          description: "d",
          proposedBy: "t",
          status: "open",
          votes: [],
          agentOutputs: [],
          createdAt: "2031-01-01T00:00:00.000Z",
        })),
        auditLog: [
          {
            id: 7,
            timestamp: "2031-01-01T00:00:00.000Z",
            proposalId: 1,
            layer: "governance",
            action: "a",
            actor: "a",
            details: "d",
          },
        ],
      };
      await fs.writeFile(path.join(daoRoot, "state.json"), JSON.stringify(state), "utf8");

      const repo = await FileDaoStateRepository.open(cwd);
      expect(repo.get().nextProposalId).toBe(43);
      expect(repo.get().nextAuditId).toBe(8);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("open() wraps corrupt JSON in a clear error naming the file (issue #167)", async () => {
    const cwd = await mkRoot();
    try {
      const daoRoot = path.join(cwd, ".dao");
      await fs.mkdir(daoRoot, { recursive: true });
      await fs.writeFile(path.join(daoRoot, "state.json"), "{not-json", "utf8");
      await expect(FileDaoStateRepository.open(cwd)).rejects.toThrow(/Corrupt DAO state.*state\.json/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("open() backs up the original file before repairing a damaged state (issue #167)", async () => {
    const cwd = await mkRoot();
    try {
      const daoRoot = path.join(cwd, ".dao");
      await fs.mkdir(daoRoot, { recursive: true });
      // Proposals key missing entirely: shape repair would silently drop it.
      await fs.writeFile(path.join(daoRoot, "state.json"), JSON.stringify({ daoRoot, initialized: true }), "utf8");

      const repo = await FileDaoStateRepository.open(cwd);
      expect(repo.get().proposals).toEqual([]);
      const entries = await fs.readdir(daoRoot);
      expect(entries.some((e) => e.startsWith("state.json.backup-"))).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
