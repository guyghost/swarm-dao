import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGraphRunner } from "@guyghost/swarm-dao-graph";
import { createProductRunner } from "@guyghost/swarm-dao-product";
import { createDeliveryRunner } from "@guyghost/swarm-dao-software-delivery";
import { main } from "../src/cli.js";

const roots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "swarm-cli-delivery-"));
  roots.push(root);
  return root;
};

const withEnvironment = async <T>(values: Record<string, string>, action: () => Promise<T>): Promise<T> => {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("swarm-dao delivery CLI route", () => {
  it("routes delivery help and the operator usage text", async () => {
    expect(await main(["delivery", "--help"], process.cwd())).toBe(0);
  });

  it("rejects init before creating a delivery when the referenced Product run is missing", async () => {
    const cwd = await tempRoot();
    const evidenceRoot = path.join(cwd, "deliveries");
    const code = await main(
      [
        "delivery",
        "init",
        "--delivery-id",
        "delivery-1",
        "--product-run-id",
        "missing-product",
        "--evidence-root",
        evidenceRoot,
        "--product-root",
        path.join(cwd, "products"),
        "--graph-root",
        path.join(cwd, "graphs"),
        "--stage-root",
        path.join(cwd, "stage"),
      ],
      cwd,
    );

    expect(code).toBe(2);
    expect(await Bun.file(evidenceRoot).exists()).toBe(false);
  });

  it("returns an execution error for malformed signal JSON", async () => {
    const cwd = await tempRoot();
    const evidenceRoot = path.join(cwd, "deliveries");
    await createDeliveryRunner({
      evidenceRoot,
      runId: "delivery-1",
      machineInput: {
        productRunId: "product-1",
        graphRunId: "delivery-1-graph",
        proposalId: "proposal-1",
        scope: "scope",
        scopeHash: "a".repeat(64),
        riskClass: "standard",
        creditsPerGraphAttempt: 1,
        observationWindowMs: 180_000,
        observationIntervalMs: 60_000,
      },
    });
    await writeFile(path.join(cwd, "bad-signal.json"), "{broken", "utf8");

    expect(
      await main(
        [
          "delivery",
          "submit",
          "--delivery-id",
          "delivery-1",
          "--signal",
          "bad-signal.json",
          "--evidence-root",
          evidenceRoot,
        ],
        cwd,
      ),
    ).toBe(1);
  });

  it("replays a run after its initial unknown risk was resolved by a human", async () => {
    const cwd = await tempRoot();
    const evidenceRoot = path.join(cwd, "deliveries");
    const runner = await createDeliveryRunner({
      evidenceRoot,
      runId: "delivery-unknown",
      machineInput: {
        productRunId: "product-1",
        graphRunId: "delivery-unknown-graph",
        proposalId: "proposal-1",
        scope: "scope",
        scopeHash: "b".repeat(64),
        riskClass: "unknown",
        creditsPerGraphAttempt: 1,
        observationWindowMs: 180_000,
        observationIntervalMs: 60_000,
      },
    });
    const signalBase = {
      runId: "delivery-unknown",
      occurredAt: "2026-09-25T12:00:00.000Z",
      payload: {},
      evidence: ["owner-reviewed-risk"],
    };
    expect(
      (await runner.submit({ ...signalBase, type: "INTAKE_ACCEPTED", source: "tool", producer: "intake-validator" }))
        .accepted,
    ).toBe(true);
    expect(
      (
        await runner.submit({
          ...signalBase,
          type: "RISK_CLASSIFICATION_RESOLVED",
          source: "human",
          producer: "human-owner",
          payload: { riskClass: "standard" },
        })
      ).accepted,
    ).toBe(true);

    expect(
      await main(["delivery", "status", "--delivery-id", "delivery-unknown", "--evidence-root", evidenceRoot], cwd),
    ).toBe(0);
  });

  it("initializes staging and resumes a Product delivery to its exact-hash Graph approval gate", async () => {
    const cwd = await tempRoot();
    await writeFile(path.join(cwd, ".gitignore"), "deliveries/\nproducts/\ngraphs/\nstage/\nbin/\n", "utf8");
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "add", ".gitignore"], { stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=Swarm test",
        "-c",
        "user.email=swarm-test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "temporary fixture",
      ],
      { stdio: "ignore" },
    );
    const evidenceRoot = path.join(cwd, "deliveries");
    const productRoot = path.join(cwd, "products");
    const graphRoot = path.join(cwd, "graphs");
    const stageRoot = path.join(cwd, "stage");
    const deliveryId = "delivery-approved-gate";
    const productRunId = "product-approved-gate";
    const occurredAt = "2026-09-25T12:00:00.000Z";
    const runDeliveryCli = (args: string[], bunPath?: string): Promise<number> =>
      withEnvironment(
        {
          SWARM_DAO_HOME: path.join(cwd, "dao-home"),
          ...(bunPath ? { PATH: bunPath } : {}),
        },
        () => main(args, cwd),
      );
    const product = await createProductRunner({ evidenceRoot: productRoot, runId: productRunId });
    const submitProduct = async (
      type: string,
      source: "ai" | "tool" | "system",
      producer: string,
      payload: Record<string, unknown> = {},
    ) => {
      const result = await product.submit({
        runId: productRunId,
        type,
        source,
        producer,
        occurredAt,
        payload,
        evidence: [`fixture:${type}`],
      });
      expect(result.accepted).toBe(true);
    };

    expect(await main(["delivery", "stage-init", "--stage-root", stageRoot], cwd)).toBe(0);
    await submitProduct("PROPOSAL_DRAFTED", "ai", "proposer", {
      draft: {
        scope: "Improve a temporary fixture",
        category: "performance",
        touchesSensitive: false,
        dependencies: [],
        budgetAllocation: 20,
        rollbackArtifact: "stage/active.json",
        evidence: "fixture:scope",
      },
    });
    await submitProduct("OPEN_PROPOSITION", "tool", "proposition-gate");
    await submitProduct("QUALIFICATION_RUN", "tool", "qualifier", {
      permissionCleared: true,
      permissionEvidence: "fixture:permissions",
    });
    await submitProduct("VOTE_OPENED", "tool", "vote-tally", {
      config: { quorum: 1, kind: "standard", expiryHours: 72 },
    });
    await submitProduct("VOTE_CAST", "tool", "vote-tally", { favorable: 1 });
    await submitProduct("VOTE_EVALUATE", "system", "product-runner");
    expect(product.snapshot().state).toBe("execution");

    const commonRoots = [
      "--evidence-root",
      evidenceRoot,
      "--product-root",
      productRoot,
      "--graph-root",
      graphRoot,
      "--stage-root",
      stageRoot,
    ];
    expect(
      await main(
        ["delivery", "init", "--delivery-id", deliveryId, "--product-run-id", productRunId, ...commonRoots],
        cwd,
      ),
    ).toBe(0);
    await writeFile(
      path.join(evidenceRoot, deliveryId, "graph-model.md"),
      "## Scope\nImprove the fixture.\n\n## Acceptance criteria\nChecks pass.\n\n## Rollback\nRestore the active pointer.\n\n## Validation\nRun fixture checks.\n",
      "utf8",
    );

    expect(
      await runDeliveryCli(["delivery", "resume", "--delivery-id", deliveryId, "--max-steps", "10", ...commonRoots]),
    ).toBe(0);
    const delivery = JSON.parse(await Bun.file(path.join(evidenceRoot, deliveryId, "snapshot.json")).text()) as {
      state: string;
      context: { modelArtifactHash: string | null };
    };
    expect(delivery.state).toBe("awaitingGraphApproval");

    expect(await runDeliveryCli(["delivery", "status", "--delivery-id", deliveryId, ...commonRoots])).toBe(0);
    expect(await main(["delivery", "scorecard", ...commonRoots], cwd)).toBe(0);

    const graphRunId = `${deliveryId}-graph`;
    const graph = await createGraphRunner({ evidenceRoot: graphRoot, runId: graphRunId });
    const modelHash = graph.snapshot().context.modelHash;
    expect(modelHash).toMatch(/^[a-f0-9]{64}$/);
    const modelBytes = await Bun.file(path.join(evidenceRoot, deliveryId, "graph-model.md")).text();
    const exactFileHash = createHash("sha256").update(modelBytes).digest("hex");
    expect(modelHash).toBe(exactFileHash);
    expect(delivery.context.modelArtifactHash).toBe(exactFileHash);
    const approval = await graph.submit({
      runId: graphRunId,
      type: "MODEL_APPROVED",
      source: "human",
      producer: "human-owner",
      occurredAt,
      payload: { modelHash },
      evidence: ["fixture:owner-approved-exact-hash"],
    });
    expect(approval.accepted).toBe(true);

    expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots])).toBe(0);
    expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots])).toBe(0);
    const graphAfterStart = await createGraphRunner({ evidenceRoot: graphRoot, runId: graphRunId });
    expect(graphAfterStart.snapshot().state).toBe("implementing");
    expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots])).toBe(0);
    const productAfterCharge = await createProductRunner({ evidenceRoot: productRoot, runId: productRunId });
    expect(productAfterCharge.snapshot().context.budget?.consumed).toBe(1);

    const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" });
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" });
    const diff = execFileSync("git", ["-C", cwd, "diff", "HEAD"], { encoding: "utf8" });
    const implementationHash = createHash("sha256").update(`${head}\n${status}\n${diff}`).digest("hex");
    const implementation = await graphAfterStart.submit({
      runId: graphRunId,
      type: "IMPLEMENTATION_READY",
      source: "ai",
      producer: "implementer",
      occurredAt,
      payload: { implementationHash },
      evidence: ["fixture:implementation-complete"],
    });
    expect(implementation.accepted).toBe(true);
    for (const [anchor, producer] of [
      ["graph-tests", "runtime-verifier"],
      ["architecture-contract", "architecture-watcher"],
      ["repository-ci", "runtime-verifier"],
      ["runtime-scenario", "runtime-verifier"],
      ["regression", "regression-watcher"],
    ]) {
      const recorded = await graphAfterStart.submit({
        runId: graphRunId,
        type: "ANCHOR_RECORDED",
        source: "tool",
        producer,
        occurredAt,
        payload: { anchor, status: "passed" },
        evidence: [`fixture:${anchor}`],
      });
      expect(recorded.accepted).toBe(true);
    }
    expect(
      (
        await graphAfterStart.submit({
          runId: graphRunId,
          type: "EVALUATE",
          source: "system",
          producer: "graph-runner",
          occurredAt,
          payload: {},
          evidence: ["fixture:anchors-evaluated"],
        })
      ).accepted,
    ).toBe(true);
    expect(graphAfterStart.snapshot().state).toBe("succeeded");

    const completedExecution = await productAfterCharge.submit({
      runId: productRunId,
      type: "EXECUTION_DONE",
      source: "tool",
      producer: "budget-ledger",
      occurredAt,
      payload: {},
      evidence: ["fixture:execution-complete"],
    });
    expect(completedExecution.accepted).toBe(true);

    const bunBin = path.join(cwd, "bin");
    await mkdir(bunBin);
    await writeFile(path.join(bunBin, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const fakeBunPath = [bunBin, process.env.PATH]
      .filter((value): value is string => Boolean(value))
      .join(path.delimiter);
    {
      expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots], fakeBunPath)).toBe(
        0,
      );
      expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots], fakeBunPath)).toBe(
        0,
      );
      expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots], fakeBunPath)).toBe(
        0,
      );
      expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots], fakeBunPath)).toBe(
        0,
      );
      const productAfterVerification = await createProductRunner({ evidenceRoot: productRoot, runId: productRunId });
      expect(productAfterVerification.snapshot().context.anchors["rollback-path-exists"]).toMatchObject({
        status: "passed",
      });
      expect(productAfterVerification.snapshot().context.controls).toHaveProperty("tests");
      expect(productAfterVerification.snapshot().state).toBe("observation");
      expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots], fakeBunPath)).toBe(
        0,
      );
      expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots], fakeBunPath)).toBe(
        0,
      );
      const active = JSON.parse(await Bun.file(path.join(stageRoot, "active.json")).text()) as {
        activeHash: string | null;
      };
      expect(active.activeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(await runDeliveryCli(["delivery", "once", "--delivery-id", deliveryId, ...commonRoots], fakeBunPath)).toBe(
        0,
      );
      const observing = JSON.parse(await Bun.file(path.join(evidenceRoot, deliveryId, "snapshot.json")).text()) as {
        state: string;
      };
      expect(observing.state).toBe("observing");
      const journal = (await Bun.file(path.join(evidenceRoot, deliveryId, "journal.ndjson"))).text().then((content) =>
        content
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ) as Promise<Array<{ kind?: string; key?: string; effect?: { key?: string; name?: string } }>>;
      const rows = await journal;
      const sampleIntent = rows.find(
        (row) => row.kind === "effect-intent" && row.effect?.name === "sample-staging-observation",
      );
      expect(sampleIntent?.effect?.key).toBeString();
      expect(rows.some((row) => row.kind === "effect-result" && row.key === sampleIntent?.effect?.key)).toBe(true);
    }
  });
});
