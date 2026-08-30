import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allRequiredAnchorsPassed,
  REQUIRED_PRODUCT_ANCHORS,
} from "../../../packages/core/src/models/product-loop.machine.js";
import { createProductRunner } from "../runner.js";

const FIXED_TIME = "2026-07-30T10:00:00.000Z";

const signal = (
  runId: string,
  type: string,
  source: "ai" | "tool" | "human" | "system",
  producer: string,
  payload: Record<string, unknown> = {},
  evidence: string[] = [],
) => ({
  runId,
  type,
  source,
  producer,
  occurredAt: FIXED_TIME,
  payload,
  evidence,
});

const draftPayload = {
  draft: {
    scope: "demo: cache the rendered proposal digest",
    category: "performance",
    touchesSensitive: false,
    dependencies: ["packages/core/src/models/proposal.machine.ts"],
    budgetAllocation: 80,
    rollbackArtifact: "evidence/rollback/digest-cache-revert.patch",
    evidence: "benchmark: digest render 42ms → 9ms over 1000 reads",
  },
};

/** Drive a runner through the full nominal path up to `validated`. */
const driveNominalPath = async (runner: Awaited<ReturnType<typeof createProductRunner>>, runId: string) => {
  const sub = (
    type: string,
    source: "ai" | "tool" | "human" | "system",
    producer: string,
    payload: Record<string, unknown> = {},
    evidence: string[] = [],
  ) => runner.submit(signal(runId, type, source, producer, payload, evidence));

  await sub("PROPOSAL_DRAFTED", "ai", "proposer", draftPayload, ["benchmark evidence"]);
  await sub("OPEN_PROPOSITION", "tool", "proposition-gate");
  await sub(
    "QUALIFICATION_RUN",
    "tool",
    "qualifier",
    {
      permissionCleared: true,
      permissionEvidence: "permissions: none required (performance category, no sensitive data)",
    },
    ["permissions: none required"],
  );
  await sub("VOTE_OPENED", "tool", "vote-tally", { config: { quorum: 3, kind: "standard", expiryHours: 72 } }, [
    "vote opened",
  ]);
  await sub("VOTE_CAST", "tool", "vote-tally", { favorable: 3 }, ["3 favorable votes"]);
  await sub("VOTE_EVALUATE", "system", "product-runner");
  await sub(
    "BUDGET_CHARGE",
    "tool",
    "budget-ledger",
    { action: { amount: 25, description: "implementation spend", evidence: "ledger: impl charge 25" } },
    ["ledger: impl charge 25"],
  );
  await sub("EXECUTION_DONE", "tool", "budget-ledger");
  await sub(
    "VERIFY_RUN",
    "tool",
    "verifier",
    { control: { name: "unit-tests", status: "passed", evidence: "bun test: 23 pass" } },
    ["bun test: 23 pass"],
  );
  await sub("ANCHOR_RECORDED", "tool", "verifier", { anchor: "frozen-set-intact", status: "passed" }, [
    "frozen set intact",
  ]);
  await sub("ANCHOR_RECORDED", "tool", "verifier", { anchor: "regression", status: "passed" }, [
    "regression suite green",
  ]);
  await sub("ANCHOR_RECORDED", "tool", "verifier", { anchor: "rollback-path-exists", status: "passed" }, [
    "rollback artifact confirmed genuine: evidence/rollback/digest-cache-revert.patch",
  ]);
  await sub("VERIFY_EVALUATE", "system", "product-runner");
};

describe("product runner — nominal path (scenario 1)", () => {
  it("reaches validated through the complete nominal path with all 9 anchors passed", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "product-runner-nominal-"));
    const runId = "product-runner-nominal";
    try {
      const runner = await createProductRunner({ evidenceRoot, runId });

      await driveNominalPath(runner, runId);

      // Three clean observation samples satisfy the ≥3 minimum and the
      // observationClean guard. OBSERVATION_EVALUATE finalises the window.
      for (const [metric, evidence] of [
        ["errors", "no errors in window"],
        ["aiCost", "ai cost within budget"],
        ["latency", "latency within threshold"],
      ] as const) {
        await runner.submit(
          signal(
            runId,
            "OBSERVATION_SAMPLE",
            "tool",
            "observation-gate",
            { sample: { metric, value: 0, threshold: 10, exceeded: false, evidence } },
            [evidence],
          ),
        );
      }
      const evalResult = await runner.submit(
        signal(runId, "OBSERVATION_EVALUATE", "system", "product-runner", { windowElapsed: true }),
      );

      expect(evalResult.accepted).toBe(true);
      expect(runner.snapshot().state).toBe("validated");
      expect(runner.snapshot().status).toBe("done");

      // The test name promises "all 9 anchors passed" — verify it against the
      // persisted snapshot rather than only the terminal state/status. Every
      // required anchor must be present, in `passed` status, and carry
      // non-empty evidence (the same invariant the model enforces at
      // `validated` via `allRequiredAnchorsPassed`).
      const anchors = runner.snapshot().context.anchors;
      expect(Object.keys(anchors)).toHaveLength(REQUIRED_PRODUCT_ANCHORS.length);
      for (const name of REQUIRED_PRODUCT_ANCHORS) {
        const result = anchors[name];
        expect(result, `anchor ${name} must be recorded`).toBeDefined();
        expect(result?.status, `anchor ${name} must be passed`).toBe("passed");
        expect(result?.evidence, `anchor ${name} must carry non-empty evidence`).toBeTruthy();
      }
      expect(allRequiredAnchorsPassed(anchors)).toBe(true);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("rejects QUALIFICATION_RUN without explicit permission clearance", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "product-runner-perm-"));
    const runId = "product-runner-perm";
    try {
      const runner = await createProductRunner({ evidenceRoot, runId });
      const sub = (
        type: string,
        source: "ai" | "tool" | "human" | "system",
        producer: string,
        payload: Record<string, unknown> = {},
        evidence: string[] = [],
      ) => runner.submit(signal(runId, type, source, producer, payload, evidence));

      await sub("PROPOSAL_DRAFTED", "ai", "proposer", draftPayload, ["benchmark"]);
      await sub("OPEN_PROPOSITION", "tool", "proposition-gate");

      // QUALIFICATION_RUN without permission fields is rejected by signal
      // validation (permissionCleared is required).
      const rejected = await runner.submit(signal(runId, "QUALIFICATION_RUN", "tool", "qualifier"));
      expect(rejected.accepted).toBe(false);
      expect(rejected.issues.join("\n")).toMatch(/permissionCleared/);
      // Machine stays in proposition.
      expect(runner.snapshot().state).toBe("proposition");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("routes to review (not ship) when rollback-path-exists anchor is missing at VERIFY_EVALUATE", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "product-runner-rollback-anchor-"));
    const runId = "product-runner-rollback-anchor";
    try {
      const runner = await createProductRunner({ evidenceRoot, runId });
      const sub = (
        type: string,
        source: "ai" | "tool" | "human" | "system",
        producer: string,
        payload: Record<string, unknown> = {},
        evidence: string[] = [],
      ) => runner.submit(signal(runId, type, source, producer, payload, evidence));

      await sub("PROPOSAL_DRAFTED", "ai", "proposer", draftPayload, ["benchmark"]);
      await sub("OPEN_PROPOSITION", "tool", "proposition-gate");
      await sub(
        "QUALIFICATION_RUN",
        "tool",
        "qualifier",
        { permissionCleared: true, permissionEvidence: "permissions: none required" },
        ["permissions: none required"],
      );
      await sub("VOTE_OPENED", "tool", "vote-tally", { config: { quorum: 1, kind: "standard", expiryHours: 72 } }, [
        "vote opened",
      ]);
      await sub("VOTE_CAST", "tool", "vote-tally", { favorable: 1 }, ["1 favorable vote"]);
      await sub("VOTE_EVALUATE", "system", "product-runner");
      await sub(
        "BUDGET_CHARGE",
        "tool",
        "budget-ledger",
        { action: { amount: 10, description: "impl", evidence: "ledger" } },
        ["ledger"],
      );
      await sub("EXECUTION_DONE", "tool", "budget-ledger");
      await sub(
        "VERIFY_RUN",
        "tool",
        "verifier",
        { control: { name: "unit-tests", status: "passed", evidence: "tests pass" } },
        ["tests pass"],
      );
      await sub("ANCHOR_RECORDED", "tool", "verifier", { anchor: "frozen-set-intact", status: "passed" }, [
        "frozen set intact",
      ]);
      await sub("ANCHOR_RECORDED", "tool", "verifier", { anchor: "regression", status: "passed" }, [
        "regression green",
      ]);
      // rollback-path-exists NOT recorded here.
      // The ship gate (canShip) requires shipGateAnchorsPassed which includes
      // rollback-path-exists. Without it, the machine falls through to the
      // isSystemVerifyEvaluate fallback and routes to review instead of ship.

      const evalResult = await runner.submit(signal(runId, "VERIFY_EVALUATE", "system", "product-runner"));
      expect(evalResult.accepted).toBe(true);
      // Machine routes to review, not ship — rollback-path-exists is mandatory.
      expect(runner.snapshot().state).toBe("review");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("product runner — observation rollback scenario (scenario 2)", () => {
  it("does not roll back after a single degraded observation — needs 3 consecutive", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "product-runner-single-degrade-"));
    const runId = "product-runner-single-degrade";
    try {
      const runner = await createProductRunner({ evidenceRoot, runId });
      await driveNominalPath(runner, runId);
      expect(runner.snapshot().state).toBe("observation");

      // Single degraded sample is accepted (changes context).
      const sampleResult = await runner.submit(
        signal(
          runId,
          "OBSERVATION_SAMPLE",
          "tool",
          "observation-gate",
          {
            sample: {
              metric: "errors",
              value: 150,
              threshold: 10,
              exceeded: true,
              evidence: "spike: 150 errors in window",
            },
          },
          ["spike: 150 errors in window"],
        ),
      );
      expect(sampleResult.accepted).toBe(true);

      // OBSERVATION_EVALUATE with one degraded sample: neither observationDegraded
      // (needs 3 consecutive) nor observationClean (needs ≥ 3 clean, windowElapsed)
      // guard fires. No state or context change → runner treats as not accepted
      // (no snapshot change), but the machine stays in observation.
      const evalResult = await runner.submit(
        signal(runId, "OBSERVATION_EVALUATE", "system", "product-runner", { windowElapsed: true }),
      );
      expect(evalResult.accepted).toBe(false);
      expect(runner.snapshot().state).toBe("observation");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("triggers rollback and corrective proposal after 3 consecutive degraded observations", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "product-runner-rollback-"));
    const runId = "product-runner-rollback";
    try {
      const runner = await createProductRunner({ evidenceRoot, runId });
      await driveNominalPath(runner, runId);
      expect(runner.snapshot().state).toBe("observation");

      // Three consecutive degraded samples on the same metric confirm rollback.
      for (let i = 0; i < 3; i++) {
        await runner.submit(
          signal(
            runId,
            "OBSERVATION_SAMPLE",
            "tool",
            "observation-gate",
            {
              sample: {
                metric: "errors",
                value: 200,
                threshold: 10,
                exceeded: true,
                evidence: `consecutive error breach ${i + 1}`,
              },
            },
            [`consecutive error breach ${i + 1}`],
          ),
        );
      }
      const evalResult = await runner.submit(
        signal(runId, "OBSERVATION_EVALUATE", "system", "product-runner", { windowElapsed: true }),
      );

      expect(evalResult.accepted).toBe(true);
      expect(runner.snapshot().state).toBe("rollback");

      // The rollback-opener tool opens a corrective proposition.
      const corrective = await runner.submit(signal(runId, "CORRECTIVE_PROPOSITION_OPENED", "tool", "rollback-opener"));
      expect(corrective.accepted).toBe(true);
      expect(runner.snapshot().state).toBe("proposition");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("does not validate with fewer than 3 clean observation samples", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "product-runner-min-samples-"));
    const runId = "product-runner-min-samples";
    try {
      const runner = await createProductRunner({ evidenceRoot, runId });
      await driveNominalPath(runner, runId);
      expect(runner.snapshot().state).toBe("observation");

      // Two clean samples are not enough to satisfy observationClean guard.
      for (const [metric, evidence] of [
        ["errors", "no errors"],
        ["aiCost", "cost ok"],
      ] as const) {
        await runner.submit(
          signal(
            runId,
            "OBSERVATION_SAMPLE",
            "tool",
            "observation-gate",
            { sample: { metric, value: 0, threshold: 10, exceeded: false, evidence } },
            [evidence],
          ),
        );
      }
      // With 2 samples, observationClean requires ≥ 3 — guard fails. Neither
      // observationDegraded fires (all clean). No transition or context change →
      // runner marks evaluate as not accepted, machine stays in observation.
      const twoSampleEval = await runner.submit(
        signal(runId, "OBSERVATION_EVALUATE", "system", "product-runner", { windowElapsed: true }),
      );
      expect(twoSampleEval.accepted).toBe(false);
      expect(runner.snapshot().state).toBe("observation");

      // A third clean sample satisfies the minimum and validates the window.
      await runner.submit(
        signal(
          runId,
          "OBSERVATION_SAMPLE",
          "tool",
          "observation-gate",
          { sample: { metric: "latency", value: 5, threshold: 50, exceeded: false, evidence: "latency ok" } },
          ["latency ok"],
        ),
      );
      const threeSampleEval = await runner.submit(
        signal(runId, "OBSERVATION_EVALUATE", "system", "product-runner", { windowElapsed: true }),
      );
      expect(threeSampleEval.accepted).toBe(true);
      expect(runner.snapshot().state).toBe("validated");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});
