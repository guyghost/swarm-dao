import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAttentionStore } from "../src/adapters/attention/fs-attention.store.js";

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
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lists only run directories under the documented evidence roots", async () => {
    const store = new FsAttentionStore(root);
    expect(await store.listRuns("graph-engineering")).toEqual(["run-1"]);
    expect(await store.listRuns("product-loop")).toEqual(["loop-1"]);
  });

  test("missing evidence root lists no runs", async () => {
    const store = new FsAttentionStore(root);
    expect(await store.listRuns("improvement-loop")).toEqual([]);
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
