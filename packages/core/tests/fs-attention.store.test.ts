import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAttentionStore } from "../src/adapters/attention/fs-attention.store.js";
import { ATTENTION_CLI_DIRS, ATTENTION_EVIDENCE_DIRS } from "../src/observability/attention.js";

describe("FsAttentionStore", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp();
    await mkdir(join(root, "evidence/graph-runs", "run-1"), { recursive: true });
    await mkdir(join(root, "evidence/product-loops", "loop-1"), { recursive: true });
    await writeFile(
      join(root, "evidence/graph-runs", "run-1", "snapshot.json"),
      JSON.stringify({
        runId: "run-1",
        state: "awaitingApproval",
        status: "active",
        context: { runId: "run-1", modelHash: "abc" },
      }),
    );
    await writeFile(
      join(root, "evidence/product-loops", "loop-1", "snapshot.json"),
      JSON.stringify({ runId: "loop-1", state: "review", status: "active", context: { reviewReason: "x" } }),
    );
    // A file (not a directory) named like a run must be ignored.
    await writeFile(join(root, "evidence/graph-runs", "stray.json"), "{}");

    // CLI-default project roots (foreign projects keep runs under .dao/).
    await mkdir(join(root, ".dao/graph-runs", "dao-run"), { recursive: true });
    await writeFile(
      join(root, ".dao/graph-runs", "dao-run", "snapshot.json"),
      JSON.stringify({ runId: "dao-run", state: "retrying", status: "active", context: {} }),
    );
    await mkdir(join(root, ".dao/improvement-cycles", "c-9"), { recursive: true });
    await writeFile(
      join(root, ".dao/improvement-cycles", "c-9", "snapshot.json"),
      JSON.stringify({ runId: "c-9", state: "adjusting", status: "active", context: { referenceHash: "h" } }),
    );
    // Same runId in both roots: the documented evidence root wins.
    await mkdir(join(root, ".dao/graph-runs", "run-1"), { recursive: true });
    await writeFile(
      join(root, ".dao/graph-runs", "run-1", "snapshot.json"),
      JSON.stringify({ runId: "run-1", state: "draft", status: "active", context: {} }),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lists only run directories under the documented evidence roots", async () => {
    const store = new FsAttentionStore(root);
    expect(await store.listRuns("graph-engineering")).toEqual(["dao-run", "run-1"]);
    expect(await store.listRuns("product-loop")).toEqual(["loop-1"]);
    expect(await store.listRuns("improvement-loop")).toEqual(["c-9"]);
  });

  test("reads snapshots from the CLI-default .dao roots", async () => {
    const store = new FsAttentionStore(root);
    const snapshot = await store.readSnapshot("graph-engineering", "dao-run");
    expect(snapshot?.state).toBe("retrying");
    const cycle = await store.readSnapshot("improvement-loop", "c-9");
    expect(cycle?.state).toBe("adjusting");
  });

  test("resolves a runId present in both roots to the documented root's snapshot", async () => {
    const store = new FsAttentionStore(root);
    const snapshot = await store.readSnapshot("graph-engineering", "run-1");
    expect(snapshot?.state).toBe("awaitingApproval");
  });

  test("documents one CLI root per source alongside the evidence root", () => {
    expect(ATTENTION_CLI_DIRS["graph-engineering"]).toBe(".dao/graph-runs");
    expect(ATTENTION_CLI_DIRS["improvement-loop"]).toBe(".dao/improvement-cycles");
    expect(ATTENTION_CLI_DIRS["improvement-series"]).toBe(".dao/improvement-series");
    expect(ATTENTION_CLI_DIRS["product-loop"]).toBe(".dao/product-loops");
    expect(ATTENTION_EVIDENCE_DIRS["graph-engineering"]).toBe("evidence/graph-runs");
  });

  test("surfaces series gates from the improvement-series roots", async () => {
    // Fresh root: only series evidence present (repo + CLI form).
    const seriesRoot = await mkdtemp();
    try {
      await mkdir(join(seriesRoot, ".dao/improvement-series", "s1"), { recursive: true });
      await writeFile(
        join(seriesRoot, ".dao/improvement-series", "s1", "snapshot.json"),
        JSON.stringify({
          seriesId: "s1",
          state: "workerFailed",
          status: "active",
          context: { seriesId: "s1", pendingReason: "herdr down" },
        }),
      );
      const store = new FsAttentionStore(seriesRoot);
      expect(await store.listRuns("improvement-series")).toEqual(["s1"]);
      // Series snapshots carry seriesId, not runId: the directory name wins.
      const snapshot = await store.readSnapshot("improvement-series", "s1");
      expect(snapshot?.state).toBe("workerFailed");
      expect(snapshot?.runId).toBe("s1");
    } finally {
      await rm(seriesRoot, { recursive: true, force: true });
    }
  });

  test("a source with no runs in any root lists none", async () => {
    const empty = await mkdtemp();
    try {
      const store = new FsAttentionStore(empty);
      expect(await store.listRuns("improvement-loop")).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("reads and validates snapshots", async () => {
    const store = new FsAttentionStore(root);
    const snapshot = await store.readSnapshot("graph-engineering", "run-1");
    expect(snapshot?.state).toBe("awaitingApproval");
    expect(snapshot?.context?.modelHash).toBe("abc");
  });

  test("rejects path traversal run ids", async () => {
    const store = new FsAttentionStore(root);
    expect(await store.readSnapshot("graph-engineering", "../graph-runs")).toBeNull();
    expect(await store.readSnapshot("graph-engineering", "run-1/../../etc")).toBeNull();
  });

  test("unknown runs and unreadable snapshots yield null", async () => {
    const store = new FsAttentionStore(root);
    expect(await store.readSnapshot("graph-engineering", "missing")).toBeNull();
    expect(await store.readSnapshot("product-loop", "stray")).toBeNull();
  });
});

async function mkdtemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "swarm-dao-attention-"));
}
