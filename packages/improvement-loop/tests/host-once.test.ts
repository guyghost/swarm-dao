// ============================================================
// Swarm DAO Improvement Loop — host-triggered advance tests
// ============================================================
import { afterEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { advanceSeriesOnce, OrchestratorRunner } from "../src/index.js";

async function gitRepo(label: string): Promise<string> {
  const root = path.join(tmpdir(), `swarm-host-once-${label}-${process.pid}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await Bun.$`git init -q`.cwd(root);
  await Bun.$`git config user.email test@example.com`.cwd(root);
  await Bun.$`git config user.name test`.cwd(root);
  await Bun.$`git commit -q --allow-empty -m init`.cwd(root);
  return root;
}

async function startedSeries(root: string, seriesId: string): Promise<void> {
  const runner = await OrchestratorRunner.create({
    seriesId,
    evidenceRoot: path.join(root, ".dao/improvement-series"),
  });
  const result = await runner.submit({
    type: "START_SERIES",
    source: "human",
    scope: "test-scope",
    referenceHash: "deadbeef",
    cooldownMs: 60_000,
  });
  if (!result.accepted) throw new Error("series did not start");
}

describe("advanceSeriesOnce", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });

  it("executes the authorized effect inside the per-series worktree", async () => {
    const root = await gitRepo("advance");
    roots.push(root);
    await startedSeries(root, "s-adv-1");

    const result = await advanceSeriesOnce({ seriesId: "s-adv-1", workDir: root });
    expect(result.executed).toBe(true);
    expect(result.event).toBe("CYCLE_INITIALIZED");
    expect(result.stateAfter).toBe("sampling");

    // The series worktree exists and is reused (idempotent), never removed.
    const worktrees = await Bun.$`git worktree list`.cwd(root).text();
    expect(worktrees).toContain("s-adv-1");

    // The operator's working tree stays untouched: no series evidence there.
    expect(await fs.readdir(path.join(root, ".dao"))).toContain("improvement-series");
  });

  it("is a no-op for a fresh (idle/terminal) series", async () => {
    const root = await gitRepo("idle");
    roots.push(root);

    const result = await advanceSeriesOnce({ seriesId: "s-idle-1", workDir: root });
    expect(result.executed).toBe(false);
    expect(result.event).toBeNull();
    expect(result.stateAfter).toBe("idle");
    expect(result.detail).toContain("terminal");
  });

  it("recovers when the worktree directory was wiped but its registration lingers", async () => {
    const root = await gitRepo("stale");
    roots.push(root);
    await startedSeries(root, "s-stale-1");

    // First advance creates the worktree; then the operator wipes .dao
    // (directory gone, registration stale, branch still around).
    await advanceSeriesOnce({ seriesId: "s-stale-1", workDir: root });
    await fs.rm(path.join(root, ".dao"), { recursive: true, force: true });
    await startedSeries(root, "s-stale-1");

    // The next advance must prune the stale registration and carve a fresh
    // worktree instead of failing on the lingering branch.
    const result = await advanceSeriesOnce({ seriesId: "s-stale-1", workDir: root });
    expect(result.executed).toBe(true);
    expect(result.event).toBe("CYCLE_INITIALIZED");
    expect(result.stateAfter).toBe("sampling");
  });

  it("honours a custom cycle evidence root (series living under evidence/)", async () => {
    const root = await gitRepo("cycleroot");
    roots.push(root);
    await startedSeries(root, "s-cyc-1");

    const result = await advanceSeriesOnce({
      seriesId: "s-cyc-1",
      workDir: root,
      cycleEvidenceRoot: "evidence/improvement-cycles",
    });
    expect(result.executed).toBe(true);
    const cycleDir = path.join(root, "evidence/improvement-cycles/s-cyc-1-c1");
    const snapshot = JSON.parse(await fs.readFile(path.join(cycleDir, "snapshot.json"), "utf8"));
    expect(snapshot.cycleId).toBe("s-cyc-1-c1");
  });

  it("throws outside a git repository", async () => {
    // Outside any repo (os tmpdir): inside the swarm-dao checkout, git would
    // discover the parent repository and carve worktrees into it.
    const root = path.join(tmpdir(), `swarm-host-once-nogit-${process.pid}`);
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "plain"), "not a repo", "utf8");

    expect(advanceSeriesOnce({ seriesId: "s-nogit", workDir: root })).rejects.toThrow(/not a git repository|worktree/i);
  });

  it("rejects a malformed persisted worker kind", async () => {
    const root = await gitRepo("badworker");
    roots.push(root);
    await fs.mkdir(path.join(root, ".dao"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".dao/improvement.json"),
      JSON.stringify({
        anchorCommands: {
          "drift-audit": "true",
          "anchor-reality": "true",
          "frozen-set-intact": "true",
          regression: "true",
        },
        worker: { kind: "../evil" },
      }),
      "utf8",
    );

    expect(advanceSeriesOnce({ seriesId: "s-bad-1", workDir: root })).rejects.toThrow(/worker.kind/);
  });
});
