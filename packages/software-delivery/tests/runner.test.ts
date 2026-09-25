import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDeliveryRunner, deriveDeliveryEffectKey } from "../src/runner.js";

const roots: string[] = [];
const clock = () => "2026-09-25T12:00:00.000Z";

const makeOptions = async (runId = "delivery-runner-test") => {
  const evidenceRoot = await mkdtemp(resolve(tmpdir(), "swarm-delivery-runner-"));
  roots.push(evidenceRoot);
  return {
    evidenceRoot,
    runId,
    clock,
    machineInput: {
      productRunId: "product-7",
      graphRunId: "graph-7",
      proposalId: "proposal-7",
      scope: "optimize-query-cache",
      scopeHash: "scope-hash-1",
      riskClass: "standard" as const,
    },
  };
};

const intakeSignal = (runId: string, overrides: Record<string, unknown> = {}) => ({
  runId,
  type: "INTAKE_ACCEPTED",
  source: "tool",
  producer: "intake-validator",
  occurredAt: clock(),
  payload: {},
  evidence: ["product-journal:8"],
  ...overrides,
});

const readJournal = async (options: { evidenceRoot: string; runId: string }) => {
  const content = await readFile(resolve(options.evidenceRoot, options.runId, "journal.ndjson"), "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("delivery runner journal and replay", () => {
  it("replays accepted signals and retains rejected signals without state change", async () => {
    const options = await makeOptions();
    const first = await createDeliveryRunner(options);
    const invalid = await first.submit(intakeSignal(options.runId, { source: "ai" }));
    expect(invalid.accepted).toBe(false);
    expect(invalid.snapshot.state).toBe("intake");
    const accepted = await first.submit(intakeSignal(options.runId));
    expect(accepted.accepted).toBe(true);
    expect(accepted.snapshot.state).toBe("draftingGraphModel");

    const resumed = await createDeliveryRunner(options);
    expect(resumed.snapshot().state).toBe("draftingGraphModel");
    expect((await readJournal(options)).map((row) => row.sequence)).toEqual([1, 2]);
    expect((await readJournal(options))[0]).toMatchObject({
      accepted: false,
      beforeState: "intake",
      afterState: "intake",
    });
    first.stop();
    resumed.stop();
  });

  it("returns independent snapshot clones", async () => {
    const options = await makeOptions();
    const runner = await createDeliveryRunner(options);
    const snapshot = runner.snapshot() as { context: { scope: string } };
    snapshot.context.scope = "mutated caller copy";

    expect(runner.snapshot().context.scope).toBe("optimize-query-cache");
    runner.stop();
  });

  it("serializes concurrent submits in invocation order", async () => {
    const options = await makeOptions();
    const runner = await createDeliveryRunner(options);
    const [intake, draft] = await Promise.all([
      runner.submit(intakeSignal(options.runId)),
      runner.submit({
        runId: options.runId,
        type: "GRAPH_MODEL_DRAFTED",
        source: "ai",
        producer: "modeler",
        occurredAt: clock(),
        payload: { modelArtifactHash: "a".repeat(64) },
        evidence: ["modeler:artifact"],
      }),
    ]);

    expect(intake.accepted).toBe(true);
    expect(draft.accepted).toBe(true);
    expect(runner.snapshot().state).toBe("validatingGraphModel");
    expect((await readJournal(options)).map((row) => row.sequence)).toEqual([1, 2]);
    runner.stop();
  });

  it("rejects corrupt lines and sequence gaps on replay", async () => {
    const options = await makeOptions();
    const runner = await createDeliveryRunner(options);
    await runner.submit(intakeSignal(options.runId));
    const journalPath = resolve(options.evidenceRoot, options.runId, "journal.ndjson");
    await appendFile(journalPath, "not-json\n");
    await expect(createDeliveryRunner(options)).rejects.toThrow(/line 2.*JSON/i);
    runner.stop();

    const gapOptions = await makeOptions("delivery-sequence-gap");
    const gapRunner = await createDeliveryRunner(gapOptions);
    await gapRunner.submit(intakeSignal(gapOptions.runId));
    const gapPath = resolve(gapOptions.evidenceRoot, gapOptions.runId, "journal.ndjson");
    const rows = await readJournal(gapOptions);
    const firstGapRow = rows[0];
    if (!firstGapRow) throw new Error("expected one journal row");
    firstGapRow.sequence = 2;
    await writeFile(gapPath, `${JSON.stringify(firstGapRow)}\n`);
    await expect(createDeliveryRunner(gapOptions)).rejects.toThrow(/sequence.*contract/);
    gapRunner.stop();
  });

  it("rejects accepted entries without replayable signals and nondeterministic state claims", async () => {
    const options = await makeOptions("delivery-missing-signal");
    const initialRunner = await createDeliveryRunner(options);
    const journalPath = resolve(options.evidenceRoot, options.runId, "journal.ndjson");
    await writeFile(
      journalPath,
      `${JSON.stringify({
        sequence: 1,
        runId: options.runId,
        receivedAt: clock(),
        kind: "signal",
        accepted: true,
        beforeState: "intake",
        afterState: "draftingGraphModel",
      })}\n`,
    );
    await expect(createDeliveryRunner(options)).rejects.toThrow(/no signal/i);
    initialRunner.stop();

    const mismatchOptions = await makeOptions("delivery-nondeterministic");
    const runner = await createDeliveryRunner(mismatchOptions);
    await runner.submit(intakeSignal(mismatchOptions.runId));
    const mismatchPath = resolve(mismatchOptions.evidenceRoot, mismatchOptions.runId, "journal.ndjson");
    const rows = await readJournal(mismatchOptions);
    const firstMismatchedRow = rows[0];
    if (!firstMismatchedRow) throw new Error("expected one journal row");
    firstMismatchedRow.afterState = "awaitingRiskReview";
    await writeFile(mismatchPath, `${JSON.stringify(firstMismatchedRow)}\n`);
    await expect(createDeliveryRunner(mismatchOptions)).rejects.toThrow(/replay|state/);
    runner.stop();
  });

  it("rejects unsafe run IDs before creating a run directory", async () => {
    const options = await makeOptions("../outside");
    await expect(createDeliveryRunner(options)).rejects.toThrow(/safe.*identifier/i);
    const reserved = { ...options, runId: "__proto__" };
    await expect(createDeliveryRunner(reserved)).rejects.toThrow(/safe.*identifier/i);
  });

  it("fails fast when another runner advances the journal", async () => {
    const options = await makeOptions("delivery-concurrent");
    const first = await createDeliveryRunner(options);
    const second = await createDeliveryRunner(options);
    await first.submit(intakeSignal(options.runId));

    await expect(second.submit(intakeSignal(options.runId))).rejects.toThrow(/concurrent.*runner|at sequence/i);
    expect((await readJournal(options)).map((row) => row.sequence)).toEqual([1]);
    first.stop();
    second.stop();
  });

  it("persists stable effect intents and results and returns completed effects idempotently", async () => {
    const options = await makeOptions("delivery-effects");
    const runner = await createDeliveryRunner(options);
    const intent = await runner.beginEffect({ name: "ship", attempt: 1, intent: { artifactHash: "a".repeat(64) } });
    expect(intent.key).toBe(deriveDeliveryEffectKey(options.runId, "ship", 1));
    expect(intent.status).toBe("pending");
    const complete = await runner.completeEffect({
      key: intent.key,
      result: { active: "a".repeat(64) },
      evidence: "stage:pointer",
    });
    expect(complete.status).toBe("completed");

    const resumed = await createDeliveryRunner(options);
    const repeated = await resumed.beginEffect({ name: "ship", attempt: 1, intent: { artifactHash: "a".repeat(64) } });
    expect(repeated.status).toBe("completed");
    expect(repeated.result).toEqual({ active: "a".repeat(64) });
    expect(await resumed.getEffect(intent.key)).toEqual(repeated);
    expect((await readJournal(options)).map((row) => row.kind)).toEqual(["effect-intent", "effect-result"]);
    runner.stop();
    resumed.stop();
  });

  it("retains an incomplete effect for reconciliation without issuing it twice", async () => {
    const options = await makeOptions("delivery-pending-effect");
    const first = await createDeliveryRunner(options);
    const intent = await first.beginEffect({
      name: "graph-implementation",
      attempt: 0,
      intent: { graphRunId: "graph-1" },
    });
    const resumed = await createDeliveryRunner(options);
    const pending = await resumed.beginEffect({
      name: "graph-implementation",
      attempt: 0,
      intent: { graphRunId: "graph-1" },
    });

    expect(pending).toEqual(intent);
    expect(pending.status).toBe("pending");
    expect(await readJournal(options)).toHaveLength(1);
    first.stop();
    resumed.stop();
  });
});
