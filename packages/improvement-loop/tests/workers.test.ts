// Unit tests for the herdr worker executor: the agent start readiness race
// (agent_pane_busy) and the stalled-prompt recovery (agent_prompt_stalled).
// workspace create returns before the fresh pane's shell is at its interactive
// prompt; herdr then fails agent start fast with agent_pane_busy. The executor
// must retry agent start on the SAME pane within the readiness budget instead
// of burning a whole attempt (fresh workspace) on a transient classification.
// Likewise, agent prompt --wait fails fast with agent_prompt_stalled when
// herdr's hardcoded 5 s state-change window is exceeded — including while the
// prompt was accepted and is being processed.
import { describe, expect, test } from "bun:test";
import { runHerdrWorker } from "../src/workers.js";

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

const PROMPT_SETTLED = JSON.stringify({
  id: "cli:agent:prompt",
  result: { agent: { name: "x", agent_status: "idle" }, type: "agent_prompted" },
});

const PROMPT_BLOCKED = JSON.stringify({
  id: "cli:agent:prompt",
  result: { agent: { name: "x", agent_status: "blocked" }, type: "agent_prompted" },
});

const AGENT_INFO = (state: string): string =>
  JSON.stringify({ id: "cli:agent:get", result: { agent: { name: "x", agent_status: state }, type: "agent_info" } });

const herdrError = (code: string): string => JSON.stringify({ error: { code, message: "rejected" } });
const BUSY = herdrError("agent_pane_busy");
const STALLED = herdrError("agent_prompt_stalled");

interface FakeScript {
  /** Per agent start call: "ok" or a herdr error JSON (last one repeats). */
  start?: string[];
  /** Per agent prompt call (last one repeats; default settled OK). */
  prompt?: { stdout?: string; stderr?: string; exitCode?: number }[];
  /** Per agent get call: agent_status (last one repeats; default "idle"). */
  get?: string[];
  /** Per agent wait call (last one repeats; default settled idle). */
  wait?: { stdout?: string; exitCode?: number }[];
}

const PROMPT_OK = { stdout: PROMPT_SETTLED, exitCode: 0 };
const PROMPT_STALLED = { stderr: STALLED, exitCode: 1 };

/** Fake herdr runner with per-command response queues (last one repeats). */
function fakeHerdr(script: FakeScript = {}) {
  const calls: string[][] = [];
  const counters = { start: 0, prompt: 0, get: 0, wait: 0 };
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
          const queue = script.prompt ?? [PROMPT_OK];
          const response = queue[Math.min(counters.prompt++, queue.length - 1)];
          return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
        }
        if (argv[2] === "get") {
          const queue = script.get ?? ["idle"];
          return { stdout: AGENT_INFO(queue[Math.min(counters.get++, queue.length - 1)]), stderr: "", exitCode: 0 };
        }
        if (argv[2] === "wait") {
          const queue = script.wait ?? [{ stdout: AGENT_INFO("idle"), exitCode: 0 }];
          const response = queue[Math.min(counters.wait++, queue.length - 1)];
          return { stdout: response.stdout ?? "", stderr: "", exitCode: response.exitCode ?? 0 };
        }
        if (argv[2] === "read") return { stdout: "TRANSCRIPT", stderr: "", exitCode: 0 };
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
  stalledGraceMs: 0,
  stalledPollIntervalMs: 0,
};

describe("runHerdrWorker agent start readiness", () => {
  test("retries agent start on the same pane while herdr reports agent_pane_busy", async () => {
    const fake = fakeHerdr({ start: [BUSY, BUSY, "ok"] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: "TRANSCRIPT" });
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
    const fake = fakeHerdr({ start: [BUSY] });
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

describe("runHerdrWorker stalled-prompt recovery", () => {
  test("waits for settle when a stalled prompt actually took effect", async () => {
    const fake = fakeHerdr({
      prompt: [PROMPT_STALLED], // one prompt call, reported stalled
      get: ["working"], // the agent came alive: the prompt took effect
      wait: [{ stdout: AGENT_INFO("idle"), exitCode: 0 }],
    });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: "TRANSCRIPT" });
    expect(fake.callsOf("prompt").length).toBe(1); // no re-prompt: no double submission
    expect(fake.callsOf("get").length).toBe(1);
    expect(fake.callsOf("wait").length).toBe(1);
  });

  test("re-prompts exactly once when the stalled submission was swallowed", async () => {
    const fake = fakeHerdr({
      prompt: [PROMPT_STALLED, PROMPT_OK],
      get: ["idle"], // never came alive: submission was swallowed
    });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: "TRANSCRIPT" });
    expect(fake.callsOf("prompt").length).toBe(2); // original + exactly one re-prompt
    expect(fake.callsOf("wait").length).toBe(0);
  });

  test("burns the attempt when the re-prompt stalls again", async () => {
    const fake = fakeHerdr({ prompt: [PROMPT_STALLED], get: ["idle"] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.includes("agent_prompt_stalled")).toBe(true);
    // 3 attempts, each: prompt → grace get → one re-prompt.
    expect(fake.callsOf("prompt").length).toBe(6);
    expect(fake.workspaceCreates().length).toBe(3);
  });
});

describe("runHerdrWorker blocked agents", () => {
  test("a blocked agent (real herdr agent_status field) is an error, never a signal", async () => {
    const fake = fakeHerdr({ prompt: [{ stdout: PROMPT_BLOCKED, exitCode: 0 }] });
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.includes("blocked")).toBe(true);
  });
});
