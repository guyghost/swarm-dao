// ============================================================
// Swarm DAO — Eval suite
// ============================================================
// "Move the gates up into evals": every frozen anchor command and
// architecture/docs gate from models/README.md, replayed as one
// battery. A run produces a scorecard (evidence/evals/<label>.json);
// `evalctl compare` diffs a candidate scorecard against a reference
// so a new harness/model binding can be adopted without regression.
//
// Deterministic by design: no LLM calls here. Live-model scenario
// runs (via the herdr worker executor) are a deferred layer that
// will write scorecards in this same shape.
//
// Commands are copied verbatim from the documented anchor tables so
// the suite can never drift from the docs silently (docs.links gates
// the tables; this suite replays them).

export type EvalArea = "graph-engineering" | "improvement-loop" | "product-loop" | "ship-audit" | "core" | "docs";

export interface EvalEntry {
  readonly id: string;
  readonly command: string;
  readonly area: EvalArea;
  /** Frozen anchors proven by this command, as named in models/README.md. */
  readonly anchors?: readonly string[];
}

export const EVAL_SUITE: readonly EvalEntry[] = [
  { id: "graph.validate", command: "bun run graph:validate", area: "graph-engineering" },
  { id: "graph.regression", command: "bun run graph:regression", area: "graph-engineering" },
  {
    id: "improvement.validate",
    command: "bun run improvement:validate",
    area: "improvement-loop",
    anchors: ["counter-metric-paired"],
  },
  {
    id: "improvement.machine",
    command: "bun test packages/core/tests/improvement-loop.machine.test.ts",
    area: "improvement-loop",
    anchors: ["drift-audit"],
  },
  {
    id: "improvement.arbitration",
    command: "bun test packages/core/tests/improvement-loop.arbitration.test.ts",
    area: "improvement-loop",
    anchors: ["arbitration-policy"],
  },
  {
    id: "improvement.anchors",
    command: "bun run improvement:anchors",
    area: "improvement-loop",
    anchors: ["anchor-reality"],
  },
  {
    id: "improvement.frozen",
    command: "bun test packages/core/tests/improvement-loop.frozen.test.ts",
    area: "improvement-loop",
    anchors: ["frozen-set-intact"],
  },
  { id: "improvement.regression", command: "bun run improvement:regression", area: "improvement-loop" },
  {
    id: "product.validate",
    command: "bun run product:validate",
    area: "product-loop",
    anchors: ["qualification-passed"],
  },
  {
    id: "product.machine",
    command: "bun test packages/core/tests/product-loop.machine.test.ts",
    area: "product-loop",
    anchors: ["controls-passed"],
  },
  {
    id: "product.regression",
    command: "bun run product:regression",
    area: "product-loop",
    anchors: ["vote-quorum", "budget-envelope", "auto-ship-policy", "observation-window"],
  },
  {
    id: "product.anchors",
    command: "bun run product:anchors",
    area: "product-loop",
    anchors: ["rollback-path-exists"],
  },
  {
    id: "product.frozen",
    command: "bun test packages/core/tests/product-loop.frozen.test.ts",
    area: "product-loop",
    anchors: ["frozen-set-intact"],
  },
  {
    id: "shipaudit.validate",
    command: "bun run shipaudit:validate",
    area: "ship-audit",
    anchors: ["audit-model-contract"],
  },
  {
    id: "shipaudit.graph",
    command: "bun test packages/core/tests/ship-audit.machine.test.ts tools/ship-audit/tests",
    area: "ship-audit",
    anchors: ["audit-graph-tests"],
  },
  {
    id: "shipaudit.wiring",
    command: "bun test packages/core/tests/ship-audit.wiring.test.ts",
    area: "ship-audit",
    anchors: ["audit-wiring-contract"],
  },
  { id: "shipaudit.regression", command: "bun run shipaudit:regression", area: "ship-audit" },
  {
    id: "core.architecture",
    command:
      "bun test packages/core/tests/architecture.contract.test.ts packages/core/tests/application.architecture.test.ts",
    area: "core",
  },
  { id: "docs.links", command: "bun run check:doc-links", area: "docs" },
  { id: "manifests.publish", command: "bun run check:publish-manifests", area: "docs" },
];

// ── Scorecard shape (stable identifiers, replayable) ─────────

export interface EvalResult {
  readonly id: string;
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stderrTail?: string;
}

export interface Scorecard {
  readonly label: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly results: readonly EvalResult[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly totalMs: number;
  };
}
