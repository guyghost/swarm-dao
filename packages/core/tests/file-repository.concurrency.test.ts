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
});
