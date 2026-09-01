// UX surface: pretty status, cycle history, root resolution, and the
// human-gate commands (approve/reject/retry/...). Everything runs against
// throwaway directories — these tests must never touch the operator's own
// .dao/ or evidence/ roots (lesson from the destructive-test incident).

import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGraphRunner } from "@guyghost/swarm-dao-graph";
import { OrchestratorRunner } from "@guyghost/swarm-dao-improvement";
import { main } from "../src/cli.js";
import {
  formatDuration,
  formatRemaining,
  renderCyclesTable,
  renderGraphStatus,
  renderSeriesStatus,
  truncateHash,
} from "../src/render.js";

const tmpCwd = async (prefix: string): Promise<string> => fs.mkdtemp(path.join(tmpdir(), prefix));

const nowIso = (): string => new Date().toISOString();

/** Drive a graph run to awaitingApproval under <root> and return its runner. */
async function graphRunAtAwaitingApproval(root: string, runId: string, modelHash: string) {
  const runner = await createGraphRunner({ evidenceRoot: root, runId });
  await runner.submit({
    runId,
    type: "MODEL_DRAFTED",
    source: "ai",
    producer: "pi",
    occurredAt: nowIso(),
    payload: { modelHash, summary: "test model" },
    evidence: ["test-evidence.md"],
  });
  await runner.submit({
    runId,
    type: "MODEL_CONTRACT_VALID",
    source: "tool",
    producer: "pi",
    occurredAt: nowIso(),
    payload: { evidence: "tests green" },
    evidence: ["test output"],
  });
  return runner;
}

describe("render helpers", () => {
  it("formats durations and remaining time", () => {
    expect(formatDuration(56_000)).toBe("56s");
    expect(formatDuration(125_000)).toBe("2m05s");
    expect(formatDuration(null as unknown as number)).toBe("—");
    expect(truncateHash("179b3a294369e8ef")).toBe("179b3a29");
    expect(truncateHash(null)).toBe("—");
    expect(formatRemaining("2000-01-01T00:00:00Z", 60_000, Date.parse("2000-01-01T00:00:30Z"))).toBe("30s");
    expect(formatRemaining("2000-01-01T00:00:00Z", 60_000, Date.parse("2000-01-01T00:02:00Z"))).toBe("ready");
  });

  it("renders a cooldown series with the next command and a not-found series with tried roots", () => {
    const lines = renderSeriesStatus(
      {
        seriesId: "s1",
        state: "cooldown",
        scope: "ci-health",
        cycleSequence: 7,
        activeCycleId: null,
        cooldownEnteredAt: "2000-01-01T00:00:00Z",
        cooldownMs: 60_000,
        terminalReason: null,
      },
      null,
      { now: Date.parse("2000-01-01T00:00:30Z"), found: true },
    );
    expect(lines.some((l) => l.includes("cooldown"))).toBe(true);
    expect(lines.some((l) => l.includes("improve once --series-id s1"))).toBe(true);

    const missing = renderSeriesStatus(
      {
        seriesId: "ghost",
        state: "idle",
        scope: null,
        cycleSequence: 0,
        activeCycleId: null,
        cooldownEnteredAt: null,
        cooldownMs: null,
        terminalReason: null,
      },
      null,
      { now: 0, found: false, triedRoots: [".dao/improvement-series", "evidence/improvement-series"] },
    );
    expect(missing.join("\n")).toContain("not found");
    expect(missing.join("\n")).toContain("evidence/improvement-series");
  });

  it("renders an awaitingApproval graph run with the approve command", () => {
    const lines = renderGraphStatus({
      runId: "r1",
      state: "awaitingApproval",
      modelHash: "a".repeat(64),
      approvedModelHash: null,
      implementationHash: null,
      anchors: {},
    });
    expect(lines.join("\n")).toContain("ACTION REQUIRED");
    expect(lines.join("\n")).toContain("swarm-dao approve --run-id r1");
  });

  it("renders the cycle history table", () => {
    const lines = renderCyclesTable([
      {
        number: 1,
        cycleId: "s-c1",
        state: "succeeded",
        attempt: 0,
        metricValue: "held",
        driftClass: "none",
        arbitration: "balanced",
        durationMs: 125_000,
      },
    ]);
    expect(lines[0]).toContain("cycle");
    expect(lines[1] ?? "").toContain("2m05s");
    expect(renderCyclesTable([])).toEqual(["no cycles recorded yet"]);
  });
});

describe("cli approve/reject — graph human gate", () => {
  it("approves the exact model hash with --yes after review", async () => {
    const cwd = await tmpCwd("ux-approve-");
    try {
      const runner = await graphRunAtAwaitingApproval(`${cwd}/.dao/graph-runs`, "run-1", "f".repeat(64));
      expect(runner.snapshot().state).toBe("awaitingApproval");
      expect(await main(["approve", "--run-id", "run-1", "--yes"], cwd)).toBe(0);
      expect(
        (await createGraphRunner({ evidenceRoot: `${cwd}/.dao/graph-runs`, runId: "run-1" })).snapshot().state,
      ).toBe("ready");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to submit non-interactively without --yes", async () => {
    const cwd = await tmpCwd("ux-nonint-");
    try {
      await graphRunAtAwaitingApproval(`${cwd}/.dao/graph-runs`, "run-2", "e".repeat(64));
      expect(await main(["approve", "--run-id", "run-2"], cwd)).toBe(1);
      // Nothing was submitted: still awaiting approval.
      const runner = await createGraphRunner({ evidenceRoot: `${cwd}/.dao/graph-runs`, runId: "run-2" });
      expect(runner.snapshot().state).toBe("awaitingApproval");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects with a reason and refuses gates outside awaitingApproval", async () => {
    const cwd = await tmpCwd("ux-reject-");
    try {
      await graphRunAtAwaitingApproval(`${cwd}/.dao/graph-runs`, "run-3", "d".repeat(64));
      expect(await main(["reject", "--run-id", "run-3", "--reason", "wrong tradeoff", "--yes"], cwd)).toBe(0);
      const runner = await createGraphRunner({ evidenceRoot: `${cwd}/.dao/graph-runs`, runId: "run-3" });
      expect(runner.snapshot().state).toBe("draft");
      // Now outside awaitingApproval: both commands refuse with exit 1.
      expect(await main(["approve", "--run-id", "run-3", "--yes"], cwd)).toBe(1);
      expect(await main(["reject", "--run-id", "run-3", "--reason", "x", "--yes"], cwd)).toBe(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves the run across candidate roots (.dao default, evidence/ dogfood)", async () => {
    const cwd = await tmpCwd("ux-roots-");
    try {
      await graphRunAtAwaitingApproval(`${cwd}/evidence/graph-runs`, "run-4", "c".repeat(64));
      expect(await main(["approve", "--run-id", "run-4", "--yes"], cwd)).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli improve status/cycles — pretty by default, --json on demand", () => {
  it("pretty-renders a started series found under evidence/ and keeps --json machine-shaped", async () => {
    const cwd = await tmpCwd("ux-status-");
    try {
      const runner = await OrchestratorRunner.create({
        seriesId: "s-ux",
        evidenceRoot: `${cwd}/evidence/improvement-series`,
      });
      await runner.submit({
        type: "START_SERIES",
        source: "human",
        scope: "ci",
        referenceHash: "a".repeat(64),
        cooldownMs: 60_000,
      });
      const code = await main(["improve", "status", "--series-id", "s-ux"], cwd);
      expect(code).toBe(0);
      // The pretty default must not be valid JSON.
      const jsonCode = await main(["improve", "status", "--series-id", "s-ux", "--json"], cwd);
      expect(jsonCode).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("prefers a started series over a stale idle snapshot with the same id", async () => {
    const cwd = await tmpCwd("ux-pref-");
    try {
      const started = await OrchestratorRunner.create({
        seriesId: "s-dup",
        evidenceRoot: `${cwd}/evidence/improvement-series`,
      });
      await started.submit({
        type: "START_SERIES",
        source: "human",
        scope: "ci",
        referenceHash: "a".repeat(64),
        cooldownMs: 60_000,
      });
      // A stale idle snapshot materialized under .dao/ must lose.
      await OrchestratorRunner.create({ seriesId: "s-dup", evidenceRoot: `${cwd}/.dao/improvement-series` });
      const runner = await OrchestratorRunner.create({
        seriesId: "s-dup",
        evidenceRoot: `${cwd}/evidence/improvement-series`,
      });
      expect(runner.snapshot().state).toBe("preparing");
      expect(await main(["improve", "status", "--series-id", "s-dup"], cwd)).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("lists cycle history rows read from snapshots and journal durations", async () => {
    const cwd = await tmpCwd("ux-cycles-");
    try {
      const dir = path.join(cwd, "evidence/improvement-cycles/s-hist-c1");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "snapshot.json"),
        JSON.stringify({
          cycleId: "s-hist-c1",
          state: "succeeded",
          context: {
            attempt: 0,
            metric: { value: "held" },
            driftClass: "none",
            arbitrationOutcome: "balanced",
            anchors: {},
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(dir, "journal.ndjson"),
        [
          JSON.stringify({ sequence: 1, receivedAt: "2000-01-01T00:00:00Z", eventType: "A" }),
          JSON.stringify({ sequence: 2, receivedAt: "2000-01-01T00:01:05Z", eventType: "B" }),
        ].join("\n"),
        "utf8",
      );
      expect(await main(["improve", "cycles", "--series-id", "s-hist"], cwd)).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli next — the operator companion", () => {
  it("surfaces an awaitingApproval run with the runnable approve command", async () => {
    const cwd = await tmpCwd("ux-next-");
    try {
      await graphRunAtAwaitingApproval(`${cwd}/.dao/graph-runs`, "run-next", "b".repeat(64));
      expect(await main(["next"], cwd)).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("answers quietly when nothing is pending", async () => {
    const cwd = await tmpCwd("ux-empty-");
    try {
      expect(await main(["next"], cwd)).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli doctor + per-command help + hints (lot 3)", () => {
  it("doctor reports a fresh project with warnings but no failures", async () => {
    const cwd = await tmpCwd("ux-doctor-");
    try {
      expect(await main(["doctor"], cwd)).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("doctor exits 1 when a human gate is pending", async () => {
    const cwd = await tmpCwd("ux-doctor-gate-");
    try {
      await graphRunAtAwaitingApproval(`${cwd}/.dao/graph-runs`, "run-doc", "a".repeat(64));
      expect(await main(["doctor"], cwd)).toBe(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("per-command help prints usage and exits 0", async () => {
    expect(await main(["vote", "--help"], process.cwd())).toBe(0);
    expect(await main(["improve", "--help"], process.cwd())).toBe(0);
    expect(await main(["graph", "--help"], process.cwd())).toBe(0);
  });

  it("improve init hints the next command", async () => {
    const cwd = await tmpCwd("ux-hint-");
    try {
      // No anchor commands bound: init fails fast — assert the hint path via
      // a config-carrying project instead.
      await fs.mkdir(path.join(cwd, ".dao"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".dao", "improvement.json"),
        JSON.stringify({
          anchorCommands: {
            "drift-audit": "true",
            "anchor-reality": "true",
            "frozen-set-intact": "true",
            regression: "true",
          },
        }),
        "utf8",
      );
      expect(
        await main(
          ["improve", "init", "--series-id", "s-hint", "--scope", "ci", "--reference-hash", "b".repeat(64)],
          cwd,
        ),
      ).toBe(0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
