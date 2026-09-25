import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deriveGraphChildRunId, inspectProductChild } from "./child-runs.js";
import type {
  DeliveryAdvanceResult,
  DeliveryExecutorPorts,
  DeliveryGraphRunView,
  DeliveryProductRunView,
} from "./executor.js";
import type { DeliveryRunner, PersistedDeliverySnapshot } from "./runner.js";
import { buildDeliveryScorecard, type DeliveryScorecardEntry } from "./scorecard.js";

type LocalStageCommandTarget = Readonly<{
  initialize: () => Promise<void>;
  inspect: () => Promise<unknown>;
}>;

export type DeliveryCommandRoots = Readonly<{
  cwd: string;
  evidenceRoot: string;
  productRoot: string;
  graphRoot: string;
  stageRoot: string;
}>;

export type DeliveryCommandDependencies = Readonly<{
  cwd: string;
  now: () => string;
  output: (text: string) => void;
  createRunner: (input: {
    evidenceRoot: string;
    runId: string;
    machineInput?: {
      productRunId: string;
      graphRunId: string;
      proposalId: string | null;
      scope: string;
      scopeHash: string;
      creditsPerGraphAttempt: number;
      observationWindowMs: number;
      observationIntervalMs: number;
      riskClass: "unknown" | "standard" | "sensitive";
    };
  }) => Promise<DeliveryRunner>;
  readDeliverySnapshot: (evidenceRoot: string, runId: string) => Promise<PersistedDeliverySnapshot | null>;
  readProductRun: (evidenceRoot: string, runId: string) => Promise<DeliveryProductRunView | null>;
  readGraphRun: (evidenceRoot: string, runId: string) => Promise<DeliveryGraphRunView | null>;
  hasReversibleStaging: (stageRoot: string) => Promise<boolean>;
  createStageTarget: (stageRoot: string) => LocalStageCommandTarget;
  createPorts: (
    roots: DeliveryCommandRoots & { deliveryRunId: string; productRunId: string; graphRunId: string },
  ) => Promise<DeliveryExecutorPorts>;
  advanceOnce: (runner: DeliveryRunner, ports: DeliveryExecutorPorts) => Promise<DeliveryAdvanceResult>;
  readScorecardEntries: (roots: DeliveryCommandRoots) => Promise<readonly DeliveryScorecardEntry[]>;
}>;

const DEFAULTS = {
  evidenceRoot: "evidence/software-deliveries",
  productRoot: ".dao/product-loops",
  graphRoot: ".dao/graph-runs",
  stageRoot: "evidence/software-delivery-stage",
  creditsPerGraphAttempt: 1,
  observationWindowMs: 180_000,
  observationIntervalMs: 60_000,
} as const;

const USAGE = `usage: swarm-dao delivery <init|status|submit|once|resume|scorecard|stage-init> [options]

  init --delivery-id <id> --product-run-id <id> [--credits-per-graph-attempt <n>]
       [--observation-window-ms <ms>] [--observation-interval-ms <ms>] [--risk-class unknown]
  status --delivery-id <id>
  submit --delivery-id <id> --signal <file.json>
  once --delivery-id <id>     advance at most one journaled effect
  resume --delivery-id <id>   continue until a human, capability, or observation wait
  scorecard [--since <ISO timestamp>]
  stage-init                  initialize or verify the empty reversible staging pointer`;

const COMMON_FLAGS = [
  "evidence-root",
  "product-root",
  "graph-root",
  "stage-root",
  "host",
  "kind",
  "keep-panes",
  "timeout-ms",
] as const;
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: [
    "delivery-id",
    "product-run-id",
    "credits-per-graph-attempt",
    "observation-window-ms",
    "observation-interval-ms",
    "risk-class",
  ],
  status: ["delivery-id"],
  submit: ["delivery-id", "signal"],
  once: ["delivery-id"],
  resume: ["delivery-id", "max-steps"],
  scorecard: ["since"],
  "stage-init": [],
};

type ParsedArgs = Readonly<{ subcommand: string | undefined; flags: ReadonlyMap<string, string | true> }>;

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { subcommand: positional[0], flags };
};

const stringFlag = (flags: ReadonlyMap<string, string | true>, name: string): string | undefined => {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || value.trim().length === 0) throw new Error(`--${name} requires a value`);
  return value;
};

const positiveIntegerFlag = (flags: ReadonlyMap<string, string | true>, name: string, fallback: number): number => {
  const raw = stringFlag(flags, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive safe integer`);
  return value;
};

const rootsFrom = (cwd: string, flags: ReadonlyMap<string, string | true>): DeliveryCommandRoots => ({
  cwd,
  evidenceRoot: resolve(cwd, stringFlag(flags, "evidence-root") ?? DEFAULTS.evidenceRoot),
  productRoot: resolve(cwd, stringFlag(flags, "product-root") ?? DEFAULTS.productRoot),
  graphRoot: resolve(cwd, stringFlag(flags, "graph-root") ?? DEFAULTS.graphRoot),
  stageRoot: resolve(cwd, stringFlag(flags, "stage-root") ?? DEFAULTS.stageRoot),
});

const safeId = (value: string, label: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
    throw new Error(`${label} must be a safe 1-128 character identifier`);
  }
  return value;
};

const actionForState = (state: string, context: Record<string, unknown>): string | null => {
  switch (state) {
    case "awaitingRiskReview":
      return "Classify the Product risk, then submit RISK_CLASSIFICATION_RESOLVED to this delivery.";
    case "awaitingGraphApproval":
      return `Approve the exact Graph model hash ${String(context.modelHash ?? "unavailable")} in Graph run ${String(context.graphRunId ?? "unavailable")}.`;
    case "awaitingShipReview":
      return `Resolve the Product review in Product run ${String(context.productRunId ?? "unavailable")}; use deploy-authorized only after owner review.`;
    case "awaitingShipCapability":
      return "Configure and confirm the required ship capability through the delivery host adapter.";
    case "observing":
      return "Wait for the configured local observation window, then run delivery resume again.";
    default:
      return null;
  }
};

const machineInputFrom = (
  snapshot: PersistedDeliverySnapshot,
): NonNullable<Parameters<DeliveryCommandDependencies["createRunner"]>[0]["machineInput"]> => {
  const context = snapshot.context;
  const creditsPerGraphAttempt = context.creditsPerGraphAttempt;
  const observationWindowMs = context.observationWindowMs;
  const observationIntervalMs = context.observationIntervalMs;
  if (
    !Number.isSafeInteger(creditsPerGraphAttempt) ||
    !Number.isSafeInteger(observationWindowMs) ||
    !Number.isSafeInteger(observationIntervalMs) ||
    (context.initialRiskClass !== "unknown" &&
      context.initialRiskClass !== "standard" &&
      context.initialRiskClass !== "sensitive")
  ) {
    throw new Error("delivery snapshot is missing immutable run configuration");
  }
  return {
    productRunId: context.productRunId,
    graphRunId: context.graphRunId,
    proposalId: context.proposalId,
    scope: context.scope,
    scopeHash: context.scopeHash,
    creditsPerGraphAttempt: creditsPerGraphAttempt as number,
    observationWindowMs: observationWindowMs as number,
    observationIntervalMs: observationIntervalMs as number,
    riskClass: context.initialRiskClass,
  };
};

const resultCode = (result: DeliveryAdvanceResult): number =>
  result.kind === "terminal" && result.state === "rejected" ? 2 : 0;

/** Operator command layer with all side effects supplied by the host adapter. */
export const runDeliveryCommand = async (
  argv: readonly string[],
  dependencies: DeliveryCommandDependencies,
): Promise<number> => {
  try {
    const { subcommand, flags } = parseArgs(argv);
    if (subcommand === undefined || flags.has("help") || flags.has("h")) {
      dependencies.output(USAGE);
      return 0;
    }
    if (!["init", "status", "submit", "once", "resume", "scorecard", "stage-init"].includes(subcommand)) {
      throw new Error(USAGE);
    }
    const allowedFlags = new Set([...COMMON_FLAGS, ...(COMMAND_FLAGS[subcommand] ?? []), "help", "h"]);
    const unknownFlags = [...flags.keys()].filter((flag) => !allowedFlags.has(flag));
    if (unknownFlags.length > 0)
      throw new Error(`unknown delivery flag(s): ${unknownFlags.map((flag) => `--${flag}`).join(", ")}\n${USAGE}`);
    const roots = rootsFrom(dependencies.cwd, flags);

    if (subcommand === "stage-init") {
      const stage = dependencies.createStageTarget(roots.stageRoot);
      await stage.initialize();
      dependencies.output(JSON.stringify(await stage.inspect(), null, 2));
      return 0;
    }

    if (subcommand === "scorecard") {
      const since = stringFlag(flags, "since");
      const entries = await dependencies.readScorecardEntries(roots);
      dependencies.output(
        JSON.stringify(
          buildDeliveryScorecard(entries, { now: dependencies.now(), ...(since ? { since } : {}) }),
          null,
          2,
        ),
      );
      return 0;
    }

    const deliveryRunId = safeId(stringFlag(flags, "delivery-id") ?? "", "--delivery-id");
    const savedSnapshot = await dependencies.readDeliverySnapshot(roots.evidenceRoot, deliveryRunId);
    if (subcommand === "init") {
      const productRunId = safeId(stringFlag(flags, "product-run-id") ?? "", "--product-run-id");
      const product = await dependencies.readProductRun(roots.productRoot, productRunId);
      if (!product) {
        dependencies.output(JSON.stringify({ accepted: false, issues: ["Product child run was not found"] }, null, 2));
        return 2;
      }
      const inspected = inspectProductChild(productRunId, product.snapshot, {
        stageRoot: roots.stageRoot,
        artifactBaseRoot: roots.cwd,
        expectedRollbackArtifact: "active.json",
      });
      if (inspected.kind === "rejected") {
        dependencies.output(JSON.stringify({ accepted: false, issues: inspected.issues }, null, 2));
        return 2;
      }
      if (!(await dependencies.hasReversibleStaging(roots.stageRoot))) {
        dependencies.output(
          JSON.stringify(
            {
              accepted: false,
              issues: ["reversible staging pointer is not initialized or intact; run delivery stage-init"],
            },
            null,
            2,
          ),
        );
        return 2;
      }
      const requestedRisk = stringFlag(flags, "risk-class");
      if (requestedRisk !== undefined && requestedRisk !== "unknown") {
        throw new Error('--risk-class currently accepts only "unknown"; known risk is derived from Product evidence');
      }
      const input = {
        productRunId,
        graphRunId: deriveGraphChildRunId(deliveryRunId),
        proposalId: inspected.proposalId,
        scope: inspected.scope,
        scopeHash: inspected.scopeHash,
        creditsPerGraphAttempt: positiveIntegerFlag(
          flags,
          "credits-per-graph-attempt",
          DEFAULTS.creditsPerGraphAttempt,
        ),
        observationWindowMs: positiveIntegerFlag(flags, "observation-window-ms", DEFAULTS.observationWindowMs),
        observationIntervalMs: positiveIntegerFlag(flags, "observation-interval-ms", DEFAULTS.observationIntervalMs),
        riskClass: requestedRisk === "unknown" ? ("unknown" as const) : inspected.riskClass,
      };
      const runner = await dependencies.createRunner({
        evidenceRoot: roots.evidenceRoot,
        runId: deliveryRunId,
        machineInput: input,
      });
      dependencies.output(
        JSON.stringify(
          { accepted: true, snapshot: runner.snapshot(), evidencePath: resolve(roots.evidenceRoot, deliveryRunId) },
          null,
          2,
        ),
      );
      return 0;
    }

    if (!savedSnapshot) {
      throw new Error(`delivery run ${deliveryRunId} was not found under ${roots.evidenceRoot}`);
    }
    const runner = await dependencies.createRunner({
      evidenceRoot: roots.evidenceRoot,
      runId: deliveryRunId,
      machineInput: machineInputFrom(savedSnapshot),
    });
    const snapshot = runner.snapshot();
    const context = snapshot.context as unknown as Record<string, unknown>;

    if (subcommand === "status") {
      const [product, graph] = await Promise.all([
        dependencies.readProductRun(roots.productRoot, String(context.productRunId)),
        dependencies.readGraphRun(roots.graphRoot, String(context.graphRunId)),
      ]);
      dependencies.output(
        JSON.stringify(
          {
            runId: snapshot.runId,
            state: snapshot.state,
            outcome: context.outcome,
            children: {
              product: { runId: context.productRunId, state: product?.snapshot.state ?? "missing" },
              graph: { runId: context.graphRunId, state: graph?.snapshot.state ?? "missing" },
            },
            requiredHumanAction: actionForState(snapshot.state, context),
            effectCheckpoint: context.effectCheckpoint,
            effects: runner.effects().map((effect) => ({
              name: effect.name,
              attempt: effect.attempt,
              status: effect.status,
              evidence: effect.evidence ?? null,
            })),
            evidencePath: resolve(roots.evidenceRoot, deliveryRunId),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (subcommand === "submit") {
      const signalFile = stringFlag(flags, "signal");
      if (!signalFile) throw new Error(`--signal is required\n${USAGE}`);
      let signal: unknown;
      try {
        signal = JSON.parse(await readFile(resolve(dependencies.cwd, signalFile), "utf8"));
      } catch (error) {
        throw new Error(`cannot read delivery signal JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      const result = await runner.submit(signal);
      dependencies.output(JSON.stringify(result, null, 2));
      return result.accepted ? 0 : 2;
    }

    const maxSteps = subcommand === "resume" ? positiveIntegerFlag(flags, "max-steps", 100) : 1;
    const ports = await dependencies.createPorts({
      ...roots,
      deliveryRunId,
      productRunId: String(context.productRunId),
      graphRunId: String(context.graphRunId),
    });
    const advance = async (): Promise<DeliveryAdvanceResult> => dependencies.advanceOnce(runner, ports);
    if (subcommand === "once") {
      const result = await advance();
      dependencies.output(JSON.stringify({ ...result, snapshot: runner.snapshot() }, null, 2));
      return resultCode(result);
    }

    let result: DeliveryAdvanceResult = { kind: "advanced", state: snapshot.state };
    let steps = 0;
    while (steps < maxSteps && result.kind === "advanced") {
      result = await advance();
      steps += 1;
    }
    dependencies.output(
      JSON.stringify(
        {
          ...result,
          steps,
          limitReached: steps === maxSteps && result.kind === "advanced",
          snapshot: runner.snapshot(),
        },
        null,
        2,
      ),
    );
    return resultCode(result);
  } catch (error) {
    dependencies.output(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
    return 1;
  }
};
