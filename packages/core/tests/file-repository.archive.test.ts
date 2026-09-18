import { beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Proposal } from "@guyghost/swarm-dao-core";
import { FileDaoStateRepository } from "@guyghost/swarm-dao-core";

let workDir: string;

function proposal(id: number, status: Proposal["status"], title = `Proposal #${id}`): Proposal {
  return {
    id,
    title,
    type: "product-feature",
    description: `Full description of proposal ${id} — deliberation detail must survive archival.`,
    problemStatement: "problem",
    acceptanceCriteria: [{ id: "ac1", given: "g", when: "w" }],
    successMetrics: ["metric"],
    rollbackConditions: ["rollback"],
    proposedBy: "tester",
    status,
    votes: [{ agentId: "a1", agentName: "Agent One", position: "for", reasoning: "ok", weight: 1 }],
    agentOutputs: [{ agentId: "a1", agentName: "Agent One", role: "reviewer", content: "output" }],
    synthesis: "synthesized decision",
    createdAt: "2031-01-01T00:00:00.000Z",
  } as Proposal;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-archive-"));
});

describe("file repository proposal archive (ADR-004)", () => {
  it("round-trips closed proposals through archive.json with full detail", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().proposals.push(proposal(1, "open"), proposal(2, "executed"));
    await repository.persist();

    const statePath = path.join(workDir, ".dao", "state.json");
    const live = await readJson(statePath);
    expect((live.proposals as unknown[]).map((p) => (p as Proposal).id)).toEqual([1]);

    const reopened = await FileDaoStateRepository.open(workDir);
    const two = reopened.get().proposals.find((p) => p.id === 2);
    expect(two?.status).toBe("executed");
    expect(two?.synthesis).toBe("synthesized decision");
    expect(two?.votes).toHaveLength(1);
    expect(two?.agentOutputs).toHaveLength(1);
    expect(two?.acceptanceCriteria).toEqual([{ id: "ac1", given: "g", when: "w" }]);
  });

  it("keeps satellite records with their proposal: outcomes for archived ids leave state.json", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    const state = repository.get();
    state.proposals.push(proposal(1, "open"), proposal(2, "executed"));
    state.outcomes[2] = { proposalId: 2, overall: 4 } as never;
    state.outcomes[1] = { proposalId: 1, overall: 5 } as never;
    await repository.persist();

    const live = await readJson(path.join(workDir, ".dao", "state.json"));
    expect(Object.keys(live.outcomes as object)).toEqual(["1"]);
    const archive = await readJson(path.join(workDir, ".dao", "archive.json"));
    expect(Object.keys(archive.outcomes as object)).toEqual(["2"]);

    const reopened = await FileDaoStateRepository.open(workDir);
    expect((reopened.get().outcomes[2] as { overall: number }).overall).toBe(4);
    expect((reopened.get().outcomes[1] as { overall: number }).overall).toBe(5);
  });

  it("resolves the crash window via the shadow rule: archived copy wins over a stale open copy", async () => {
    // Simulated crash-after-archive-write: archive holds #5 closed, state.json
    // still lists #5 as open (older content). mergeArchive must keep exactly
    // one proposal and it must be the closed one.
    const daoDir = path.join(workDir, ".dao");
    await fs.mkdir(daoDir, { recursive: true });
    await fs.writeFile(
      path.join(daoDir, "state.json"),
      JSON.stringify({
        initialized: true,
        daoRoot: daoDir,
        nextProposalId: 6,
        stateRevision: 3,
        proposals: [proposal(5, "open")],
      }),
    );
    await fs.writeFile(
      path.join(daoDir, "archive.json"),
      JSON.stringify({
        version: 1,
        proposals: [proposal(5, "executed")],
        controlResults: {},
        deliveryPlans: {},
        artefacts: {},
        outcomes: {},
        snapshots: {},
        verifications: {},
      }),
    );

    const repository = await FileDaoStateRepository.open(workDir);
    expect(repository.get().proposals).toHaveLength(1);
    expect(repository.get().proposals[0]?.status).toBe("executed");

    await repository.persist();
    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().proposals).toHaveLength(1);
    expect(reopened.get().proposals[0]?.status).toBe("executed");
  });

  it("persists an in-place archived value edit only when markArchivedDirty was called", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().proposals.push(proposal(5, "executed"));
    await repository.persist();

    const reopened = await FileDaoStateRepository.open(workDir);
    reopened.get().outcomes[5] = { proposalId: 5, overall: 3, ratedBy: "rater" } as never;
    reopened.markArchivedDirty();
    await reopened.persist();

    const afterFlag = await FileDaoStateRepository.open(workDir);
    expect((afterFlag.get().outcomes[5] as { overall: number }).overall).toBe(3);
  });

  it("auto-detects structural archive changes (new satellite entry) without the flag", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().proposals.push(proposal(5, "executed"));
    await repository.persist();

    const reopened = await FileDaoStateRepository.open(workDir);
    reopened.get().outcomes[5] = { proposalId: 5, overall: 4 } as never; // new key: signature changes
    await reopened.persist();

    const after = await FileDaoStateRepository.open(workDir);
    expect(after.get().outcomes[5]).toBeDefined();
  });

  it("keeps a no-op persist byte-identical (revision untouched)", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().proposals.push(proposal(1, "open"), proposal(2, "executed"));
    await repository.persist();

    const statePath = path.join(workDir, ".dao", "state.json");
    const archivePath = path.join(workDir, ".dao", "archive.json");
    const stateBefore = await fs.readFile(statePath, "utf8");
    const archiveBefore = await fs.readFile(archivePath, "utf8");

    await repository.persist();
    await repository.persist();

    expect(await fs.readFile(statePath, "utf8")).toBe(stateBefore);
    expect(await fs.readFile(archivePath, "utf8")).toBe(archiveBefore);
  });

  it("repairs counters past archived ids so a restored old state.json cannot collide", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().proposals.push(proposal(700, "executed"));
    repository.get().nextProposalId = 701;
    await repository.persist();

    // Restored old state.json: only open proposals, counter rolled back.
    const daoDir = path.join(workDir, ".dao");
    const state = JSON.parse(await fs.readFile(path.join(daoDir, "state.json"), "utf8")) as Record<string, unknown>;
    state.nextProposalId = 2;
    await fs.writeFile(path.join(daoDir, "state.json"), JSON.stringify(state, null, 2));

    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().nextProposalId).toBeGreaterThan(700);
  });

  it("still refuses stale writers through the revision gate", async () => {
    const first = await FileDaoStateRepository.open(workDir);
    const second = await FileDaoStateRepository.open(workDir);
    first.get().proposals.push(proposal(1, "open"));
    await first.persist();

    second.get().proposals.push(proposal(1, "open"));
    await expect(second.persist()).rejects.toThrow(/Concurrent modification/);
  });

  it("loadState (compat path) also merges the archive instead of clobbering it", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().proposals.push(proposal(1, "open"), proposal(2, "executed"));
    repository.get().outcomes[2] = { proposalId: 2, overall: 4 } as never;
    await repository.persist();

    // The compat seam used by tests/hosts that bypass the repository port:
    // loadState must hand back the merged state, and the next save must not
    // destroy archived proposals (regression: archive was rewritten from
    // archive-blind memory, dropping #2).
    const { loadState, saveState } = await import("@guyghost/swarm-dao-core");
    const loaded = await loadState(workDir);
    expect(loaded?.proposals.map((p) => p.id)).toEqual([1, 2]);
    await saveState();

    const reopened = await FileDaoStateRepository.open(workDir);
    expect(reopened.get().proposals.map((p) => p.id)).toEqual([1, 2]);
    expect(reopened.get().proposals.find((p) => p.id === 2)?.status).toBe("executed");
  });

  it("keeps decisions/ summaries correct with archived proposals", async () => {
    const repository = await FileDaoStateRepository.open(workDir);
    repository.get().proposals.push(proposal(1, "open"), proposal(2, "executed"));
    await repository.persist();

    const index = await readJson(path.join(workDir, ".dao", "decisions", "index.json"));
    expect((index as unknown as { proposals?: unknown[] }).proposals ?? index).toBeDefined();
    const entries = index as unknown as Array<{ id: number; status: string }>;
    expect(Array.isArray(entries) ? entries.map((d) => d.id) : []).toEqual([2]);
  });

  it("migrates a legacy monolithic state.json on the first writing persist", async () => {
    const daoDir = path.join(workDir, ".dao");
    await fs.mkdir(daoDir, { recursive: true });
    await fs.writeFile(
      path.join(daoDir, "state.json"),
      JSON.stringify({
        initialized: true,
        daoRoot: daoDir,
        nextProposalId: 3,
        stateRevision: 1,
        proposals: [proposal(1, "open"), proposal(2, "executed")],
      }),
    );

    const repository = await FileDaoStateRepository.open(workDir);
    expect(repository.get().proposals).toHaveLength(2); // inline closed still load

    await repository.persist();
    const live = await readJson(path.join(daoDir, "state.json"));
    expect((live.proposals as unknown[]).map((p) => (p as Proposal).id)).toEqual([1]);
    expect(
      await fs.access(path.join(daoDir, "archive.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);

    // The persist after migration is a full no-op.
    const stateBefore = await fs.readFile(path.join(daoDir, "state.json"), "utf8");
    await repository.persist();
    expect(await fs.readFile(path.join(daoDir, "state.json"), "utf8")).toBe(stateBefore);
  });
});
