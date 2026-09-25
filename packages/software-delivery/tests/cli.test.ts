import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { PersistedProductSnapshot } from "@guyghost/swarm-dao-product";
import { type DeliveryCommandDependencies, runDeliveryCommand } from "../src/command.js";
import type { DeliveryAdvanceResult, DeliveryExecutorPorts } from "../src/executor.js";
import type { DeliveryRunner, PersistedDeliverySnapshot } from "../src/runner.js";

const roots: string[] = [];
const NOW = "2026-09-25T12:00:00.000Z";

const productSnapshot = (runId = "product-1"): PersistedProductSnapshot =>
  ({
    runId,
    state: "execution",
    status: "active",
    context: {
      runId,
      proposalId: "proposal-1",
      improvementCycleId: null,
      draft: {
        scope: "add a small feature",
        category: "tooling",
        touchesSensitive: false,
        dependencies: [],
        budgetAllocation: 10,
        rollbackArtifact: "evidence/software-delivery-stage/active.json",
        evidence: "product:scope",
      },
      voteConfig: { quorum: 1, kind: "standard", expiryHours: 72 },
      favorableVotes: 1,
      budget: { initial: 10, consumed: 1, history: [] },
      controls: {},
      observationSamples: [],
      contactVoteOpen: false,
      contactVoteQuorumReached: false,
      contactRelayAuthorized: false,
      reviewReason: null,
      permissionsCleared: true,
      permissionEvidence: "product:permission",
      signalLog: [],
      anchors: {
        "vote-quorum": { status: "passed", evidence: "vote:1" },
        "budget-envelope": { status: "passed", evidence: "budget:10" },
      },
      terminalReason: null,
    },
  }) as PersistedProductSnapshot;

class FakeRunner {
  readonly #snapshot: PersistedDeliverySnapshot;
  readonly submitted: unknown[] = [];
  constructor(
    runId: string,
    input?: NonNullable<Parameters<DeliveryCommandDependencies["createRunner"]>[0]["machineInput"]>,
  ) {
    this.#snapshot = {
      runId,
      state: "intake",
      status: "active",
      sequence: 0,
      context: {
        runId,
        productRunId: input?.productRunId ?? "product-1",
        graphRunId: input?.graphRunId ?? `${runId}-graph`,
        proposalId: input?.proposalId ?? "proposal-1",
        scope: input?.scope ?? "add a small feature",
        scopeHash: input?.scopeHash ?? "d".repeat(64),
        creditsPerGraphAttempt: input?.creditsPerGraphAttempt ?? 1,
        observationWindowMs: input?.observationWindowMs ?? 180_000,
        observationIntervalMs: input?.observationIntervalMs ?? 60_000,
        initialRiskClass: input?.riskClass ?? "standard",
        riskClass: input?.riskClass ?? "standard",
        modelArtifactHash: null,
        modelHash: null,
        approvedModelHash: null,
        implementationHash: null,
        artifactHash: null,
        effectCheckpoint: null,
        observationEvidence: [],
        rollbackRequired: false,
        rollbackConfirmed: false,
        cancellationRequested: false,
        cancellationEvidence: null,
        outcome: null,
        terminalEvidence: null,
      },
    };
  }
  snapshot(): PersistedDeliverySnapshot {
    return structuredClone(this.#snapshot);
  }
  async submit(signal: unknown): Promise<{ accepted: boolean; issues: string[]; snapshot: PersistedDeliverySnapshot }> {
    this.submitted.push(signal);
    return { accepted: true, issues: [], snapshot: this.snapshot() };
  }
  effects() {
    return [];
  }
}

const makeDeps = (
  options: { product?: PersistedProductSnapshot | null; advanceResults?: DeliveryAdvanceResult[] } = {},
) => {
  const root = mkdtempSync(resolve(tmpdir(), "swarm-delivery-command-"));
  roots.push(root);
  const output: string[] = [];
  let runner: FakeRunner | null = null;
  let createRunnerCalls = 0;
  let createPortsCalls = 0;
  let stageInitializations = 0;
  let advances = 0;
  const advanceResults = [
    ...(options.advanceResults ?? [
      { kind: "waiting-human", state: "awaitingGraphApproval", reason: "await approval" },
    ]),
  ];
  const deps: DeliveryCommandDependencies = {
    cwd: root,
    now: () => NOW,
    output: (value) => output.push(value),
    createRunner: async ({ runId, machineInput }) => {
      createRunnerCalls += 1;
      runner = runner ?? new FakeRunner(runId, machineInput);
      return runner as unknown as DeliveryRunner;
    },
    readDeliverySnapshot: async () => (runner ? runner.snapshot() : null),
    readProductRun: async (_evidenceRoot, runId) => {
      if (options.product === null) return null;
      const snapshot = options.product ?? productSnapshot(runId);
      return { snapshot, acceptedSignals: [] };
    },
    readGraphRun: async (_evidenceRoot, runId) => ({
      snapshot: {
        runId,
        state: "draft",
        status: "active",
        context: { runId, attempt: 0, modelHash: null, approvedModelHash: null, anchors: {} },
      } as never,
      acceptedSignals: [],
    }),
    hasReversibleStaging: async () => true,
    createStageTarget: () => ({
      initialize: async () => {
        stageInitializations += 1;
      },
      inspect: async () => ({ intact: true, activeHash: null }),
    }),
    createPorts: async () => {
      createPortsCalls += 1;
      return {} as DeliveryExecutorPorts;
    },
    advanceOnce: async () => {
      advances += 1;
      return advanceResults.shift() ?? { kind: "terminal", state: "validated", outcome: "validated" };
    },
    readScorecardEntries: async () => [],
  };
  return {
    deps,
    output,
    get runner() {
      return runner;
    },
    get createRunnerCalls() {
      return createRunnerCalls;
    },
    get createPortsCalls() {
      return createPortsCalls;
    },
    get stageInitializations() {
      return stageInitializations;
    },
    get advances() {
      return advances;
    },
  };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("runDeliveryCommand", () => {
  it("initializes only after Product and reversible staging pass, with positive immutable settings", async () => {
    const setup = makeDeps();
    const code = await runDeliveryCommand(
      [
        "init",
        "--delivery-id",
        "delivery-1",
        "--product-run-id",
        "product-1",
        "--credits-per-graph-attempt",
        "2",
        "--observation-window-ms",
        "120000",
        "--observation-interval-ms",
        "30000",
      ],
      setup.deps,
    );

    expect(code).toBe(0);
    expect(setup.runner?.snapshot().context).toMatchObject({
      creditsPerGraphAttempt: 2,
      observationWindowMs: 120_000,
      observationIntervalMs: 30_000,
      graphRunId: "delivery-1-graph",
    });
    expect(setup.createPortsCalls).toBe(0);

    const invalid = await runDeliveryCommand(
      ["init", "--delivery-id", "delivery-2", "--product-run-id", "product-1", "--credits-per-graph-attempt", "0"],
      setup.deps,
    );
    expect(invalid).toBe(1);
  });

  it("returns machine rejection before creating an executor when Product preflight fails", async () => {
    const setup = makeDeps({ product: null });
    const code = await runDeliveryCommand(
      ["init", "--delivery-id", "delivery-1", "--product-run-id", "missing"],
      setup.deps,
    );
    expect(code).toBe(2);
    expect(setup.createRunnerCalls).toBe(0);
    expect(setup.createPortsCalls).toBe(0);
  });

  it("can conservatively hold a Product run at unknown-risk review", async () => {
    const setup = makeDeps();
    expect(
      await runDeliveryCommand(
        ["init", "--delivery-id", "delivery-unknown", "--product-run-id", "product-1", "--risk-class", "unknown"],
        setup.deps,
      ),
    ).toBe(0);
    expect(setup.runner?.snapshot().context.initialRiskClass).toBe("unknown");
    expect(setup.runner?.snapshot().state).toBe("intake");
  });

  it("rejects unknown flags and non-positive resume limits", async () => {
    const setup = makeDeps();
    expect(await runDeliveryCommand(["init", "--delivery-id", "delivery-1", "--typo"], setup.deps)).toBe(1);
    expect(
      await runDeliveryCommand(["init", "--delivery-id", "delivery-1", "--product-run-id", "product-1"], setup.deps),
    ).toBe(0);
    expect(await runDeliveryCommand(["resume", "--delivery-id", "delivery-1", "--max-steps", "0"], setup.deps)).toBe(1);
    expect(setup.advances).toBe(0);
  });

  it("handles status, one-effect execution, and resume stopping at a human gate", async () => {
    const setup = makeDeps({
      advanceResults: [
        { kind: "advanced", state: "awaitingGraphApproval" },
        { kind: "waiting-human", state: "awaitingGraphApproval", reason: "owner approval required" },
      ],
    });
    await runDeliveryCommand(["init", "--delivery-id", "delivery-1", "--product-run-id", "product-1"], setup.deps);
    expect(await runDeliveryCommand(["status", "--delivery-id", "delivery-1"], setup.deps)).toBe(0);
    expect(JSON.parse(setup.output.at(-1) ?? "{}").children.graph.state).toBe("draft");
    expect(await runDeliveryCommand(["once", "--delivery-id", "delivery-1"], setup.deps)).toBe(0);
    expect(setup.advances).toBe(1);
    expect(await runDeliveryCommand(["resume", "--delivery-id", "delivery-1"], setup.deps)).toBe(0);
    expect(setup.advances).toBe(2);
    expect(setup.output.at(-1)).toContain('"kind": "waiting-human"');
  });

  it("rejects malformed signal JSON, supports scorecard, and initializes staging", async () => {
    const setup = makeDeps();
    await runDeliveryCommand(["init", "--delivery-id", "delivery-1", "--product-run-id", "product-1"], setup.deps);
    const signalPath = resolve(setup.deps.cwd, "bad.json");
    await writeFile(signalPath, "{bad", "utf8");
    expect(
      await runDeliveryCommand(["submit", "--delivery-id", "delivery-1", "--signal", "bad.json"], setup.deps),
    ).toBe(1);
    expect(await runDeliveryCommand(["scorecard"], setup.deps)).toBe(0);
    expect(setup.output.at(-1)).toContain('"completion"');
    expect(await runDeliveryCommand(["stage-init"], setup.deps)).toBe(0);
    expect(setup.stageInitializations).toBe(1);
  });
});
