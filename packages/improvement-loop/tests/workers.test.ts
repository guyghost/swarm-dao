// Unit tests for the herdr worker executor: the agent start readiness race.
// workspace create returns before the fresh pane's shell is at its interactive
// prompt; herdr then fails agent start fast with agent_pane_busy. The executor
// must retry agent start on the SAME pane within the readiness budget instead
// of burning a whole attempt (fresh workspace) on a transient classification.
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
  result: { agent: { name: "x", status: "idle" }, type: "ok" },
});

const herdrError = (code: string): string => JSON.stringify({ error: { code, message: "pane rejected the start" } });
const BUSY = herdrError("agent_pane_busy");

/** Fake herdr runner: scripted agent start responses (last one repeats), happy
 * path for every other lifecycle command. */
function fakeHerdr(startResponses: string[]) {
  const calls: string[][] = [];
  let startCall = 0;
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
          const response = startResponses[Math.min(startCall++, startResponses.length - 1)];
          return response === "ok"
            ? { stdout: AGENT_STARTED, stderr: "", exitCode: 0 }
            : { stdout: "", stderr: response, exitCode: 1 };
        }
        if (argv[2] === "prompt") return { stdout: PROMPT_SETTLED, stderr: "", exitCode: 0 };
        if (argv[2] === "read") return { stdout: "TRANSCRIPT", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    },
  };
  const startCalls = (): string[][] => calls.filter((argv) => argv[1] === "agent" && argv[2] === "start");
  const workspaceCreates = (): string[][] => calls.filter((argv) => argv[1] === "workspace" && argv[2] === "create");
  return { runner, startCalls, workspaceCreates };
}

const BASE_OPTIONS = {
  workDir: "/tmp/repo",
  startTimeoutMs: 30_000,
  readinessRetryDelayMs: 0,
};

describe("runHerdrWorker agent start readiness", () => {
  test("retries agent start on the same pane while herdr reports agent_pane_busy", async () => {
    const fake = fakeHerdr([BUSY, BUSY, "ok"]);
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result).toEqual({ ok: true, content: "TRANSCRIPT" });
    expect(fake.startCalls().length).toBe(3);
    for (const call of fake.startCalls()) {
      expect(call).toContain("w9:p1"); // same pane across retries
      expect(call).toContain("sensor"); // same agent name across retries
    }
    expect(fake.workspaceCreates().length).toBe(1); // no attempt burned
  });

  test("does not same-pane-retry non-readiness agent start failures", async () => {
    const fake = fakeHerdr([herdrError("unsupported_agent_kind")]);
    const result = await runHerdrWorker({ ...BASE_OPTIONS, runner: fake.runner }, "sensor", "PROMPT");
    expect(result.ok).toBe(false);
    expect(fake.startCalls().length).toBe(3); // one per attempt, no inner retry
    expect(fake.workspaceCreates().length).toBe(3); // each attempt got a fresh workspace
    // Distinct agent names per attempt (fresh-workspace retry semantics kept).
    expect(fake.startCalls()[0]).toContain("sensor");
    expect(fake.startCalls()[1]).toContain("sensor-r2");
    expect(fake.startCalls()[2]).toContain("sensor-r3");
    expect(result.ok === false && result.error.includes("unsupported_agent_kind")).toBe(true);
  });

  test("gives up the pane after the readiness budget and retries with a fresh workspace", async () => {
    const fake = fakeHerdr([BUSY]);
    const result = await runHerdrWorker(
      { ...BASE_OPTIONS, startTimeoutMs: 1_000, runner: fake.runner },
      "sensor",
      "PROMPT",
    );
    expect(result.ok).toBe(false);
    // Attempt 1 polled the busy pane at least once more before giving up;
    // attempts 2 and 3 carved fresh workspaces with retry agent names.
    expect(fake.startCalls().length).toBeGreaterThan(3);
    expect(fake.workspaceCreates().length).toBe(3);
    expect(result.ok === false && result.error.includes("agent_pane_busy")).toBe(true);
  });
});
