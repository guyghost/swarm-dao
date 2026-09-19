import { afterEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CLASSIFIER_CHARTER, DEFAULT_ATTEMPT_STATE, type ToolEvidence } from "@guyghost/swarm-dao-core";
import {
  composeImplementerPrompt,
  extractLastJsonObject,
  harvestVerdict,
  type ImplementingPorts,
  implementerSignalFrom,
  runGraphImplementing,
  runImplementingLoop,
  TOOLS_NOT_RUN,
  type TurnResult,
} from "../src/implementing.js";
import { createGraphRunner } from "../src/runner.js";

const NOW = "2026-09-17T18:00:00.000Z";

const doneVerdict = {
  status: "done",
  confidence: 0.9,
  failureType: "none",
  nextAction: "finish",
  affectedPaths: [],
  reason: "types and tests are green",
};

const retryVerdict = {
  status: "retry",
  confidence: 0.8,
  failureType: "type_error",
  nextAction: "edit_file",
  affectedPaths: ["packages/core/src/foo.ts"],
  reason: "implicit cast",
};

const escalateVerdict = {
  status: "escalate",
  confidence: 0.9,
  failureType: "unknown",
  nextAction: "handoff_human",
  affectedPaths: [],
  reason: "needs an owner decision",
};

const transcriptOf = (value: unknown): string =>
  `echoed charter ${CLASSIFIER_CHARTER.slice(0, 40)}\n${JSON.stringify(value)}\n`;

const tmpRoot = async (label: string): Promise<string> => {
  const root = path.join(import.meta.dir, `.tmp-implementing-${label}-${process.pid}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  return root;
};

const signal = (
  runId: string,
  type: string,
  source: string,
  producer: string,
  payload: Record<string, unknown> = {},
  evidence: string[] = ["evidence"],
) => ({
  runId,
  type,
  source,
  producer,
  occurredAt: NOW,
  payload,
  evidence,
});

async function reachImplementing(root: string, runId: string) {
  const runner = await createGraphRunner({ evidenceRoot: root, runId, clock: () => NOW });
  const submit = async (...args: Parameters<typeof signal>) => {
    const result = await runner.submit(signal(...args));
    expect(result.accepted).toBe(true);
  };
  await submit(runId, "MODEL_DRAFTED", "ai", "modeler", { modelHash: "model-a" }, ["model"]);
  await submit(runId, "MODEL_CONTRACT_VALID", "tool", "model-contract-validator", {}, ["contract"]);
  await submit(runId, "MODEL_APPROVED", "human", "human-owner", { modelHash: "model-a" }, ["approved"]);
  await submit(runId, "START_IMPLEMENTATION", "system", "graph-runner", {}, []);
  expect(runner.snapshot().state).toBe("implementing");
  return runner;
}

const scriptedPorts = (
  transcripts: string[],
  tools: ToolEvidence = { tests: "passed", types: "passed", lint: "not_run" },
) => {
  const prompts: string[] = [];
  const ports: ImplementingPorts = {
    turn: async (prompt) => {
      prompts.push(prompt);
      const next = transcripts.shift();
      if (next === undefined) return { ok: false, error: "no more turns" };
      return { ok: true, transcript: next };
    },
    runTools: async () => tools,
    implementationHash: async () => "implementation-a",
  };
  return { ports, prompts };
};

describe("composeImplementerPrompt", () => {
  it("prepends CLASSIFIER_CHARTER and never drops the task", () => {
    const prompt = composeImplementerPrompt({ task: "ship the retry hop", followUp: "fix the JSON" });
    expect(prompt.startsWith(CLASSIFIER_CHARTER)).toBe(true);
    expect(prompt).toContain("ship the retry hop");
    expect(prompt).toContain("fix the JSON");
  });
});

describe("harvestVerdict", () => {
  it("reads the last JSON object, ignoring the echoed charter template", () => {
    const harvested = harvestVerdict(transcriptOf(doneVerdict));
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) throw new Error(harvested.errors.join("; "));
    expect(harvested.verdict.status).toBe("done");
  });

  it("fails closed when the transcript has no JSON object", () => {
    expect(extractLastJsonObject("just prose")).toBeNull();
    expect(harvestVerdict("just prose").ok).toBe(false);
  });
});

describe("runImplementingLoop", () => {
  it("re-prompts invalid JSON then requests evaluation once tools pass", async () => {
    const { ports, prompts } = scriptedPorts(["not json", transcriptOf(doneVerdict)]);
    const result = await runImplementingLoop({ task: "implement the model" }, ports);
    expect(result).toEqual({
      kind: "request_evaluation",
      implementationHash: "implementation-a",
      reason: "types and tests are green",
      turns: 2,
    });
    expect(prompts[0]).toContain(CLASSIFIER_CHARTER);
    expect(prompts[1]).toContain("not a valid classifier verdict");
    expect(implementerSignalFrom(result)?.type).toBe("IMPLEMENTATION_READY");
  });

  it("overrides a lying done and keeps going", async () => {
    const { ports } = scriptedPorts([transcriptOf(doneVerdict), transcriptOf(doneVerdict)], {
      tests: "failed",
      types: "not_run",
      lint: "not_run",
    });
    const result = await runImplementingLoop(
      { task: "implement the model", state: { ...DEFAULT_ATTEMPT_STATE, maxRetries: 1 } },
      ports,
    );
    expect(result.kind).toBe("failed");
    expect(result.reason).toMatch(/tool checks failed/);
    expect(implementerSignalFrom(result)?.type).toBe("IMPLEMENTATION_FAILED");
  });

  it("does not emit a graph signal when the model asks for a human", async () => {
    const { ports } = scriptedPorts([transcriptOf(escalateVerdict)]);
    const result = await runImplementingLoop({ task: "implement the model" }, ports);
    expect(result.kind).toBe("escalate");
    expect(implementerSignalFrom(result)).toBeNull();
  });

  it("blocks when the worker cannot spawn", async () => {
    const ports: ImplementingPorts = {
      turn: async () => ({ ok: false, error: "herdr is down" }) satisfies TurnResult,
      runTools: async () => TOOLS_NOT_RUN,
      implementationHash: async () => "x",
    };
    const result = await runImplementingLoop({ task: "implement the model" }, ports);
    expect(result).toEqual({ kind: "block", reason: "herdr is down", turns: 0 });
    expect(implementerSignalFrom(result)).toBeNull();
  });

  it("continues an honest retry without running tools", async () => {
    let toolsRan = 0;
    const transcripts = [transcriptOf(retryVerdict), transcriptOf(doneVerdict)];
    const result = await runImplementingLoop(
      { task: "implement the model" },
      {
        turn: async () => {
          const next = transcripts.shift();
          if (!next) return { ok: false, error: "empty" };
          return { ok: true, transcript: next };
        },
        runTools: async () => {
          toolsRan += 1;
          return { tests: "passed", types: "passed", lint: "not_run" };
        },
        implementationHash: async () => "implementation-a",
      },
    );
    expect(result.kind).toBe("request_evaluation");
    expect(toolsRan).toBe(1);
  });
});

describe("runGraphImplementing", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("refuses unless the run is implementing", async () => {
    const root = await tmpRoot("draft");
    roots.push(root);
    await createGraphRunner({ evidenceRoot: root, runId: "run-1", clock: () => NOW });
    const { ports } = scriptedPorts([transcriptOf(doneVerdict)]);
    const result = await runGraphImplementing({
      evidenceRoot: root,
      runId: "run-1",
      task: "implement the model",
      ports,
      now: () => NOW,
    });
    expect(result.submitted).toBe(false);
    expect(result.error).toMatch(/not implementing/);
    expect(result.snapshot.state).toBe("draft");
  });

  it("submits IMPLEMENTATION_READY after a valid done + tools", async () => {
    const root = await tmpRoot("ready");
    roots.push(root);
    await reachImplementing(root, "run-ready");
    const { ports } = scriptedPorts([transcriptOf(doneVerdict)]);
    const result = await runGraphImplementing({
      evidenceRoot: root,
      runId: "run-ready",
      task: "implement the model",
      ports,
      now: () => NOW,
    });
    expect(result.submitted).toBe(true);
    expect(result.snapshot.state).toBe("verifying");
    expect(result.snapshot.context.implementationHash).toBe("implementation-a");
    expect(result.submission?.accepted).toBe(true);
  });

  it("submits IMPLEMENTATION_FAILED when the inner budget is exhausted", async () => {
    const root = await tmpRoot("failed");
    roots.push(root);
    await reachImplementing(root, "run-fail");
    const { ports } = scriptedPorts([transcriptOf(doneVerdict), transcriptOf(doneVerdict)], {
      tests: "failed",
      types: "not_run",
      lint: "not_run",
    });
    const result = await runGraphImplementing({
      evidenceRoot: root,
      runId: "run-fail",
      task: "implement the model",
      state: { ...DEFAULT_ATTEMPT_STATE, maxRetries: 1 },
      ports,
      now: () => NOW,
    });
    expect(result.loop.kind).toBe("failed");
    expect(result.submitted).toBe(true);
    expect(result.snapshot.state).toBe("implementing");
    expect(result.snapshot.context.attempt).toBe(1);
  });

  it("leaves the run in implementing when the model escalates", async () => {
    const root = await tmpRoot("escalate");
    roots.push(root);
    await reachImplementing(root, "run-esc");
    const { ports } = scriptedPorts([transcriptOf(escalateVerdict)]);
    const result = await runGraphImplementing({
      evidenceRoot: root,
      runId: "run-esc",
      task: "implement the model",
      ports,
      now: () => NOW,
    });
    expect(result.submitted).toBe(false);
    expect(result.snapshot.state).toBe("implementing");
    expect(result.snapshot.context.implementationHash).toBeNull();
  });
});
