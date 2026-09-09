// Unit tests for the herdr worker executor: the agent start readiness race
// (agent_pane_busy) and the state-detection-free transcript harvest (issue
// #148). workspace create returns before the fresh pane's shell is at its
// interactive prompt; herdr then fails agent start fast with agent_pane_busy.
// The executor must retry agent start on the SAME pane within the readiness
// budget instead of burning a whole attempt (fresh workspace) on a transient
// classification.
//
// Prompt submission uses NO --wait: herdr state detection misreads busy
// coding-agent panes (agent_prompt_stalled with a frozen state_change_seq
// while the worker works, and grace-poll recovery re-prompts a live worker).
// The transcript itself is the authority: the executor polls `herdr agent
// read` until the last JSON object satisfies the worker contract (resolved
// value, non-placeholder evidence) or the output settles.
import { describe, expect, test } from "bun:test";
import { extractLastJsonObject, isWorkerContract, runHerdrWorker } from "../src/workers.js";

const WORKSPACE_CREATED = JSON.stringify({
  id: "cli:workspace:create",
  result: {
    root_pane: { pane_id: "w9:p1" },
    workspace: { workspace_id: "w9" },
    type: "workspace_created",
  },
});

const AGENT_STARTED = JSON.stringify({
  id: "cli:agent:start",
  result: { agent: { name: "x", status: "idle" }, type: "agent_started" },
});

type Response = { stdout?: string; stderr?: string; exitCode?: number };

const herdrError = (code: string): string => JSON.stringify({ error: { code, message: "rejected" } });

// The prompt template workers are told to answer with (orchestrator.ts
// WORKER_PROMPTS); an agent that merely echoes it has not answered.
const PROMPT_TEMPLATE = '{"sample": {"value": "improved|held|declined", "evidence": "<concise observation>"}}';

const SENSOR_ANSWER =
  '{"sample": {"value": "improved", "evidence": "cargo test duration fell from 41s to 9s across five runs."}}';

const DRIFT_ANSWER = '{"driftClass": "none", "evidence": "arbitration still rejects declined counter-samples."}';

const PROSE = "The agent narrates its work without ever answering the contract.";

const READ_OK: Response = { stdout: SENSOR_ANSWER, exitCode: 0 };

interface FakeScript {
  /** Per agent start call: "ok" or a herdr error JSON (last one repeats). */
  start?: string[];
  /** Per agent prompt call (last one repeats; default accepted). */
  prompt?: Response[];
  /** Per agent read call (last one repeats) or a per-call function (e.g.
   * ever-growing transcripts that never settle). */
  read?: Response[] | ((call: number) => Response);
}

/** Fake herdr runner with per-command response queues (last one repeats). */
function fakeHerdr(script: FakeScript = {}) {
  const calls: string[][] = [];
  const counters = { start: 0, prompt: 0, read: 0 };
  const runner = {
    exec: async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[1] === "workspace") {
        if (argv[2] === "list")
          return { stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "", exitCode: 0 };
        return { stdout: WORKSPACE_CREATED, stderr: "", exitCode: 0 };
      }
      if (argv[1] === "agent") {
        if (argv[2] === "start") {
          const queue = script.start ?? ["ok"];
          const response = queue[Math.min(counters.start++, queue.length - 1)];
          return response === "ok"
            ? { stdout: AGENT_STARTED, stderr: "", exitCode: 0 }
            : { stdout: "", stderr: response, exitCode: 1 };
        }
        if (argv[2] === "prompt") {
          const queue = script.prompt ?? [{ exitCode: 0 }];
          const response = queue[Math.min(counters.prompt++, queue.length - 1)];
          return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
        }
        if (argv[2] === "read") {
          const source = script.read ?? [READ_OK];
          const response =
            typeof source === "function"
              ? source(counters.read++)
              : source[Math.min(counters.read++, source.length - 1)];
          return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
        }
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    },
  };
  const callsOf = (subcommand: string): string[][] =>
    calls.filter((argv) => argv[1] === "agent" && argv[2] === subcommand);
  const workspaceCreates = (): string[][] => calls.filter((argv) => argv[1] === "workspace" && argv[2] === "create");
  return { runner, callsOf, workspaceCreates };
}

const BASE_OPTIONS = {
  workDir: "/tmp/repo",
  startTimeoutMs: 30_000,
  readinessRetryDelayMs: 0,
  pollIntervalMs: 0,
};

describe("runHerdrWorker agent start readiness", () => {
  test("retries agent start on the same pane while herdr reports agent_pane_busy", async () => {
    const fake = fakeHerdr({ start: [herdrError("agent_pane_busy"), herdrError("agent_pane_busy"), "ok"] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: SENSOR_ANSWER });
    const starts = fake.callsOf("start");
    expect(starts.length).toBe(3);
    for (const call of starts) {
      expect(call).toContain("w9:p1"); // same pane across retries
      expect(call).toContain("sensor"); // same agent name across retries
    }
    expect(fake.workspaceCreates().length).toBe(1); // no attempt burned
  });

  test("does not same-pane-retry non-readiness agent start failures", async () => {
    const fake = fakeHerdr({ start: [herdrError("unsupported_agent_kind")] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result.ok).toBe(false);
    expect(fake.callsOf("start").length).toBe(3); // one per attempt, no inner retry
    expect(fake.workspaceCreates().length).toBe(3); // each attempt got a fresh workspace
    // Distinct agent names per attempt (fresh-workspace retry semantics kept).
    expect(fake.callsOf("start")[0]).toContain("sensor");
    expect(fake.callsOf("start")[1]).toContain("sensor-r2");
    expect(fake.callsOf("start")[2]).toContain("sensor-r3");
    expect(result.ok === false && result.error.includes("unsupported_agent_kind")).toBe(true);
  });

  test("gives up the pane after the readiness budget and retries with a fresh workspace", async () => {
    const fake = fakeHerdr({ start: [herdrError("agent_pane_busy")] });
    const result = await runHerdrWorker(
      { ...BASE_OPTIONS, startTimeoutMs: 1_000, runner: fake.runner },
      "sensor",
      "PROMPT",
    );
    expect(result.ok).toBe(false);
    // Attempt 1 polled the busy pane at least once more before giving up;
    // attempts 2 and 3 carved fresh workspaces with retry agent names.
    expect(fake.callsOf("start").length).toBeGreaterThan(3);
    expect(fake.workspaceCreates().length).toBe(3);
    expect(result.ok === false && result.error.includes("agent_pane_busy")).toBe(true);
  });
});

describe("runHerdrWorker transcript harvest", () => {
  test("submits the prompt without --wait and harvests the contract transcript", async () => {
    const fake = fakeHerdr();
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: SENSOR_ANSWER });
    const promptCall = fake.callsOf("prompt")[0];
    expect(promptCall).toContain("sensor");
    expect(promptCall).toContain("PROMPT");
    expect(promptCall).not.toContain("--wait");
    expect(promptCall).not.toContain("--timeout");
    const readCall = fake.callsOf("read")[0];
    expect(readCall).toContain("recent-unwrapped");
    expect(readCall.join(" ")).toMatch(/--lines \d+/);
  });

  test("accepts the real answer only once the echoed prompt template is gone", async () => {
    const transcript = `${PROMPT_TEMPLATE}\n${SENSOR_ANSWER}`;
    const fake = fakeHerdr({
      read: [
        { stdout: PROMPT_TEMPLATE, exitCode: 0 },
        { stdout: transcript, exitCode: 0 },
      ],
    });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: transcript });
    // Integration: the harvested transcript feeding extractLastJsonObject
    // yields the contract (last JSON object wins over the echoed template).
    expect(extractLastJsonObject(transcript)?.sample).toEqual({
      value: "improved",
      evidence: "cargo test duration fell from 41s to 9s across five runs.",
    });
  });

  test("accepts a drift contract answered at top level (driftClass + evidence)", async () => {
    const transcript = `comparing reference...\n${DRIFT_ANSWER}`;
    const fake = fakeHerdr({ read: [{ stdout: transcript, exitCode: 0 }] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "drift-auditor", "PROMPT");
    expect(result).toEqual({ ok: true, content: transcript });
  });

  test("repairs hard-wrapped JSON before contract matching", async () => {
    const wrapped = 'preamble {"sample": {"value": "held",\n"evidence": "metric flat across\nall five runs."}}';
    const fake = fakeHerdr({ read: [{ stdout: wrapped, exitCode: 0 }] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(extractLastJsonObject(result.content)?.sample).toEqual({
        value: "held",
        evidence: "metric flat across\nall five runs.",
      });
    }
  });

  test("keeps polling through transient read failures until the contract appears", async () => {
    const fake = fakeHerdr({ read: [{ exitCode: 1, stderr: herdrError("pane_gone") }, READ_OK] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: SENSOR_ANSWER });
    expect(fake.callsOf("read").length).toBe(2);
  });

  test("fails the attempt when the transcript settles without a contract, naming the captured size", async () => {
    const fake = fakeHerdr({ read: [{ stdout: PROSE, exitCode: 0 }] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.includes("settled without a valid contract")).toBe(true);
    expect(result.ok === false && /captured \d+ chars/.test(result.error)).toBe(true);
    // Exactly one prompt per attempt: double submission is structurally
    // impossible (no stall classification, no recovery re-prompt).
    expect(fake.callsOf("prompt").length).toBe(3);
  });

  test("fails the attempt at the harvest deadline when the transcript never settles", async () => {
    let call = 0;
    const fake = fakeHerdr({ read: () => ({ stdout: `${PROSE} x`.repeat(++call), exitCode: 0 }) });
    const result = await runHerdrWorker(
      { ...BASE_OPTIONS, timeoutMs: 1_000, pollIntervalMs: 50, runner: fake.runner },
      "sensor",
      "PROMPT",
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && /captured \d+ chars/.test(result.error)).toBe(true);
    expect(fake.callsOf("prompt").length).toBe(3);
  });

  test("surfaces a failed prompt submission as an attempt error without harvesting", async () => {
    const fake = fakeHerdr({ prompt: [{ exitCode: 1, stderr: herdrError("unknown_agent") }] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.includes("unknown_agent")).toBe(true);
    expect(fake.callsOf("read").length).toBe(0);
  });
});

describe("isWorkerContract", () => {
  test("accepts sample and drift contracts with real evidence", () => {
    expect(isWorkerContract(extractLastJsonObject(SENSOR_ANSWER))).toBe(true);
    expect(isWorkerContract(extractLastJsonObject(DRIFT_ANSWER))).toBe(true);
  });

  test("rejects the echoed prompt template (menu value, placeholder evidence)", () => {
    expect(isWorkerContract(extractLastJsonObject(PROMPT_TEMPLATE))).toBe(false);
  });

  test("rejects answers without evidence or with placeholder evidence", () => {
    expect(isWorkerContract(extractLastJsonObject('{"sample": {"value": "improved", "evidence": ""}}'))).toBe(false);
    expect(isWorkerContract(extractLastJsonObject('{"sample": {"value": "improved", "evidence": "<todo>"}}'))).toBe(
      false,
    );
    expect(isWorkerContract(extractLastJsonObject('{"driftClass": "none"}'))).toBe(false);
  });

  test("rejects non-contract shapes and absent JSON", () => {
    expect(isWorkerContract(null)).toBe(false);
    expect(isWorkerContract(extractLastJsonObject(PROSE))).toBe(false);
    expect(isWorkerContract(extractLastJsonObject('{"foo": 1}'))).toBe(false);
  });
});
