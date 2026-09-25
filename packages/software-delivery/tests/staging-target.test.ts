import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createLocalStagingTarget } from "../src/staging-target.js";

const stageRoots: string[] = [];
const createTarget = async (content = "patch-a") => {
  const stageRoot = await mkdtemp(resolve(tmpdir(), "swarm-delivery-stage-"));
  stageRoots.push(stageRoot);
  return {
    stageRoot,
    target: createLocalStagingTarget({ stageRoot, snapshotSource: async () => content }),
  };
};

afterEach(async () => {
  for (const stageRoot of stageRoots.splice(0)) await rm(stageRoot, { recursive: true, force: true });
});

describe("local reversible staging target", () => {
  it("ships one immutable artifact and restores the empty baseline", async () => {
    const { target } = await createTarget();
    await target.initialize();

    const artifact = await target.snapshot();
    const shipped = await target.ship({ effectId: "delivery-1:ship:1", artifact });
    expect(shipped.artifactHash).toBe(artifact.hash);
    expect((await target.inspect()).activeHash).toBe(shipped.artifactHash);

    const rolledBack = await target.rollback({
      effectId: "delivery-1:rollback:1",
      expectedActiveHash: shipped.artifactHash,
    });
    expect(rolledBack.restoredHash).toBeNull();
    expect((await target.inspect()).activeHash).toBeNull();
  });

  it("proves the active pointer and rollback artifact can be restored before Product ship", async () => {
    const { target } = await createTarget();
    await target.initialize();
    const proof = await target.verifyRollbackPath();

    expect(proof).toMatchObject({ restorable: true, activeHash: null, rollbackHash: null });
    expect(proof.evidence).toContain("verified");
    expect((await target.inspect()).intact).toBe(true);
  });

  it("returns prior results for duplicate effects and rejects key reuse with a different artifact", async () => {
    const { target } = await createTarget();
    await target.initialize();
    const artifact = await target.snapshot();
    const first = await target.ship({ effectId: "delivery-2:ship:1", artifact });
    const replay = await target.ship({ effectId: "delivery-2:ship:1", artifact });
    expect(replay).toEqual(first);

    const otherArtifact = await createTarget("patch-b");
    const different = await otherArtifact.target.snapshot();
    await expect(target.ship({ effectId: "delivery-2:ship:1", artifact: different })).rejects.toThrow(
      /effect.*different|different.*effect/i,
    );
  });

  it("refuses rollback when the active pointer has changed since ship", async () => {
    const { target, stageRoot } = await createTarget();
    await target.initialize();
    const shipped = await target.ship({ effectId: "delivery-3:ship:1", artifact: await target.snapshot() });
    const pointerPath = resolve(stageRoot, "active.json");
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    pointer.activeHash = "c".repeat(64);
    await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);

    await expect(
      target.rollback({ effectId: "delivery-3:rollback:1", expectedActiveHash: shipped.artifactHash }),
    ).rejects.toThrow(/active.*changed|expected.*active/i);
  });

  it("reports a missing immutable blob and refuses rollback", async () => {
    const { target, stageRoot } = await createTarget();
    await target.initialize();
    const shipped = await target.ship({ effectId: "delivery-4:ship:1", artifact: await target.snapshot() });
    await unlink(resolve(stageRoot, "artifacts", shipped.artifactHash));

    const inspection = await target.inspect();
    expect(inspection.intact).toBe(false);
    expect((await target.verifyRollbackPath()).restorable).toBe(false);
    await expect(
      target.rollback({ effectId: "delivery-4:rollback:1", expectedActiveHash: shipped.artifactHash }),
    ).rejects.toThrow(/missing|integrity|blob/i);
  });

  it("ignores an orphaned temporary pointer from an interrupted atomic update", async () => {
    const { target, stageRoot } = await createTarget();
    await mkdir(stageRoot, { recursive: true });
    await writeFile(resolve(stageRoot, ".active.json.interrupted.tmp"), "{partial");

    await target.initialize();
    expect(await target.inspect()).toMatchObject({ activeHash: null, intact: true });
    expect(JSON.parse(await readFile(resolve(stageRoot, "active.json"), "utf8"))).toMatchObject({
      activeHash: null,
      effectId: "baseline",
    });
  });

  it("makes rollback replay idempotent", async () => {
    const { target } = await createTarget();
    await target.initialize();
    const shipped = await target.ship({ effectId: "delivery-5:ship:1", artifact: await target.snapshot() });
    const input = { effectId: "delivery-5:rollback:1", expectedActiveHash: shipped.artifactHash };
    const first = await target.rollback(input);
    const replay = await target.rollback(input);

    expect(replay).toEqual(first);
    expect((await target.inspect()).activeHash).toBeNull();
  });
});
