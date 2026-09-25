import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { PersistedGraphSnapshot } from "@guyghost/swarm-dao-graph";
import type { PersistedProductSnapshot } from "@guyghost/swarm-dao-product";
import {
  type AcceptedChildSignal,
  deriveGraphChildRunId,
  inspectGraphChild,
  inspectProductChild,
  openGraphChild,
  openProductChild,
  submitGraphChildSignal,
  submitProductChildSignal,
} from "../src/child-runs.js";

const roots: string[] = [];
const modelHash = "a".repeat(64);
const rollbackHash = "b".repeat(64);

const productSnapshot = (overrides: Record<string, unknown> = {}): PersistedProductSnapshot =>
  ({
    runId: "product-7",
    state: "execution",
    status: "active",
    context: {
      runId: "product-7",
      proposalId: "proposal-7",
      improvementCycleId: null,
      draft: {
        scope: "optimize-query-cache",
        category: "performance",
        touchesSensitive: false,
        dependencies: [],
        budgetAllocation: 20,
        rollbackArtifact: `rollback/${rollbackHash}.json`,
        evidence: "product:scope-evidence",
      },
      voteConfig: { quorum: 1, kind: "standard", expiryHours: 72 },
      favorableVotes: 1,
      budget: { initial: 20, consumed: 2, history: [] },
      controls: {},
      observationSamples: [],
      contactVoteOpen: false,
      contactVoteQuorumReached: false,
      contactRelayAuthorized: false,
      reviewReason: null,
      permissionsCleared: true,
      permissionEvidence: "product:permissions-clear",
      signalLog: [],
      anchors: {
        "vote-quorum": { status: "passed", evidence: "vote:4" },
        "budget-envelope": { status: "passed", evidence: "budget:1" },
      },
      terminalReason: null,
    },
    ...overrides,
  }) as PersistedProductSnapshot;

const productSnapshotWithDraft = (
  patch: Partial<NonNullable<PersistedProductSnapshot["context"]["draft"]>>,
): PersistedProductSnapshot => {
  const base = productSnapshot();
  const draft = base.context.draft;
  if (!draft) throw new Error("test fixture requires a Product draft");
  return productSnapshot({ context: { ...base.context, draft: { ...draft, ...patch } } });
};

const graphSnapshot = (overrides: Record<string, unknown> = {}): PersistedGraphSnapshot =>
  ({
    runId: "graph-7",
    state: "ready",
    status: "active",
    context: {
      runId: "graph-7",
      modelHash,
      approvedModelHash: modelHash,
      implementationHash: null,
      anchors: { "model-contract": { status: "passed", evidence: "contract:passed", attempt: 0 } },
      attempt: 0,
      maxRetries: 2,
      terminalReason: null,
    },
    ...overrides,
  }) as PersistedGraphSnapshot;

const approval = (hash = modelHash): AcceptedChildSignal => ({
  sequence: 4,
  eventType: "MODEL_APPROVED",
  source: "human",
  producer: "human-owner",
  payload: { modelHash: hash },
  evidence: ["graph:owner-approval"],
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("delivery child run adapters", () => {
  it("derives a stable safe Graph child ID from the delivery ID", () => {
    const shortId = deriveGraphChildRunId("delivery-7");
    const longId = deriveGraphChildRunId(`delivery-${"a".repeat(115)}`);

    expect(shortId).toBe("delivery-7-graph");
    expect(deriveGraphChildRunId("delivery-7")).toBe(shortId);
    expect(longId.length).toBeLessThanOrEqual(128);
    expect(() => deriveGraphChildRunId("../unsafe")).toThrow(/safe/);
  });

  it("accepts Product execution with sealed quorum, budget, remaining units, and scoped rollback artifact", () => {
    const result = inspectProductChild("product-7", productSnapshot(), { stageRoot: "/tmp/delivery-stage" });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.riskClass).toBe("standard");
    expect(result.scopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.budgetRemaining).toBe(18);
    expect(result.rollbackArtifact).toBe(`rollback/${rollbackHash}.json`);
  });

  it("rejects intake when no reversible staging root is configured", () => {
    expect(inspectProductChild("product-7", productSnapshot()).kind).toBe("rejected");
  });

  it("rejects the wrong Product run, wrong state, missing anchors, and exhausted budget", () => {
    expect(inspectProductChild("another-product", productSnapshot()).kind).toBe("rejected");
    expect(inspectProductChild("product-7", productSnapshot({ state: "verification" })).kind).toBe("rejected");

    const missingAnchor = productSnapshot();
    missingAnchor.context.anchors["vote-quorum"] = { status: "failed", evidence: "vote:failed" };
    expect(inspectProductChild("product-7", missingAnchor).kind).toBe("rejected");

    const noBudget = productSnapshot();
    noBudget.context.budget = { initial: 20, consumed: 20, history: [] };
    expect(inspectProductChild("product-7", noBudget).kind).toBe("rejected");
  });

  it("derives sensitive risk and rejects rollback artifacts outside the configured stage root", () => {
    const sensitive = productSnapshotWithDraft({ category: "security" });
    expect(inspectProductChild("product-7", sensitive, { stageRoot: "/tmp/delivery-stage" }).kind).toBe("ready");
    const sensitiveResult = inspectProductChild("product-7", sensitive, { stageRoot: "/tmp/delivery-stage" });
    expect(sensitiveResult.kind === "ready" && sensitiveResult.riskClass).toBe("sensitive");

    const outside = productSnapshotWithDraft({ rollbackArtifact: "../outside/rollback.json" });
    const rejected = inspectProductChild("product-7", outside, { stageRoot: "/tmp/delivery-stage" });
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind === "rejected") expect(rejected.issues.join("\n")).toMatch(/rollback.*stag|stag.*rollback/i);
  });

  it("requires a replayable accepted Graph approval for the exact model hash", () => {
    const good = inspectGraphChild("graph-7", graphSnapshot(), [approval()]);
    expect(good.kind).toBe("ready");

    const wrongHash = inspectGraphChild("graph-7", graphSnapshot(), [approval("c".repeat(64))]);
    expect(wrongHash.kind).toBe("waiting");
    const wrongId = inspectGraphChild("another-graph", graphSnapshot(), [approval()]);
    expect(wrongId.kind).toBe("invalid");

    const unapprovedImplementation = inspectGraphChild("graph-7", graphSnapshot({ state: "implementing" }), []);
    expect(unapprovedImplementation.kind).toBe("invalid");
  });

  it("opens Product runs through ProductRunner and rejects a corrupt journal", async () => {
    const evidenceRoot = await mkdtemp(resolve(tmpdir(), "swarm-product-child-"));
    roots.push(evidenceRoot);
    const opened = await openProductChild({ evidenceRoot, runId: "product-child-open" });
    expect(opened.snapshot.runId).toBe("product-child-open");
    expect(opened.acceptedSignals).toEqual([]);

    const corruptRoot = await mkdtemp(resolve(tmpdir(), "swarm-product-child-corrupt-"));
    roots.push(corruptRoot);
    const runDirectory = resolve(corruptRoot, "product-child-corrupt");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(resolve(runDirectory, "journal.ndjson"), "not-json\n");
    await expect(openProductChild({ evidenceRoot: corruptRoot, runId: "product-child-corrupt" })).rejects.toThrow(
      /journal.*JSON/i,
    );
  });

  it("routes child changes only through the public runner and forbids forwarding human signals", async () => {
    const evidenceRoot = await mkdtemp(resolve(tmpdir(), "swarm-product-child-signal-"));
    roots.push(evidenceRoot);
    const opened = await openProductChild({ evidenceRoot, runId: "product-child-signal" });
    await expect(
      submitProductChildSignal(opened.runner, {
        runId: "product-child-signal",
        type: "CANCEL",
        source: "human",
        producer: "human-owner",
        occurredAt: "2026-09-25T12:00:00.000Z",
        payload: { reason: "must remain human-owned" },
        evidence: ["owner:cancel"],
      }),
    ).rejects.toThrow(/human.*event|human.*signal/i);
    expect(opened.runner.snapshot().state).toBe("exploration");
  });

  it("opens Graph runs and routes non-human changes through GraphRunner", async () => {
    const evidenceRoot = await mkdtemp(resolve(tmpdir(), "swarm-graph-child-signal-"));
    roots.push(evidenceRoot);
    const opened = await openGraphChild({ evidenceRoot, runId: "graph-child-signal" });
    const drafted = await submitGraphChildSignal(opened.runner, {
      runId: "graph-child-signal",
      type: "MODEL_DRAFTED",
      source: "ai",
      producer: "modeler",
      occurredAt: "2026-09-25T12:00:00.000Z",
      payload: { modelHash },
      evidence: ["modeler:model"],
    });

    expect(drafted.accepted).toBe(true);
    expect(drafted.snapshot.state).toBe("modelReview");
    await expect(
      submitGraphChildSignal(opened.runner, {
        runId: "graph-child-signal",
        type: "MODEL_APPROVED",
        source: "human",
        producer: "human-owner",
        occurredAt: "2026-09-25T12:00:00.000Z",
        payload: { modelHash },
        evidence: ["owner:approval"],
      }),
    ).rejects.toThrow(/human.*event|human.*signal/i);
  });
});
