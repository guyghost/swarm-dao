import { describe, expect, it } from "bun:test";
import { extractLastJsonObject, type HerdrWorkerOptions, runHerdrWorker, toBoundedInt } from "../workers.js";

describe("extractLastJsonObject — terminal-harvested transcripts", () => {
  it("parses the last JSON object and ignores earlier prompt templates", () => {
    const content = '{"sample": {"value": "x"}} trailing {"sample": {"value": "held", "evidence": "ok"}}';
    expect(extractLastJsonObject(content)).toEqual({ sample: { value: "held", evidence: "ok" } });
  });

  it("repairs raw newlines that terminal hard-wraps inject inside string literals", () => {
    // Real dogfood-002 corruption: a herdr read returned a JSON answer whose
    // evidence string contained a literal newline mid-token (invalid JSON).
    const content = '{"sample": {"value": "held", "evidence": "series start\n (12:58Z), clean."}}';
    expect(extractLastJsonObject(content)).toEqual({
      sample: { value: "held", evidence: "series start\n (12:58Z), clean." },
    });
  });

  it("repairs tabs and carriage returns inside strings without touching escaped sequences", () => {
    const content = '{"sample": {"value": "a\\\\b", "evidence": "x\\ty\\r\\nz"}}';
    expect(extractLastJsonObject(content)).toEqual({ sample: { value: "a\\b", evidence: "x\ty\r\nz" } });
  });

  it("drops a hard-wrap injected between a backslash and its escaped character (Copilot review on #79)", () => {
    // Original JSON escape \\n split by a terminal wrap -> backslash, RAW newline, 'n'.
    const splitEscape = '{"sample": {"value": "a\\' + "\n" + 'nb", "evidence": "e"}}';
    expect(extractLastJsonObject(splitEscape)).toEqual({ sample: { value: "a\nb", evidence: "e" } });

    // Original escaped quote \\" split by a wrap -> backslash, RAW newline, quote:
    // the quote must stay escaped instead of closing the string.
    const splitQuote = '{"sample": {"value": "say \\' + "\n" + '"kept", "evidence": "e"}}';
    expect(extractLastJsonObject(splitQuote)).toEqual({ sample: { value: 'say "kept', evidence: "e" } });
  });

  it("still returns null when no JSON object exists", () => {
    expect(extractLastJsonObject("no json here")).toBeNull();
  });
});

describe("herdr worker executor — numeric option sanitization", () => {
  it("coerces bounds on numeric options", () => {
    expect(toBoundedInt(undefined, 300, 1, 10_000)).toBe(300);
    expect(toBoundedInt(Number.NaN, 300, 1, 10_000)).toBe(300);
    expect(toBoundedInt("500; rm -rf /", 300, 1, 10_000)).toBe(300);
    expect(toBoundedInt(50, 300, 1_000, 300_000)).toBe(1_000);
    expect(toBoundedInt(999_999, 300, 1, 10_000)).toBe(10_000);
    expect(toBoundedInt(12.9, 300, 1, 10_000)).toBe(12);
  });

  it("never interpolates unsanitized numeric options into herdr commands", async () => {
    const commands: string[][] = [];
    const ok = (stdout: unknown) => ({ stdout: JSON.stringify(stdout), stderr: "", exitCode: 0 });
    const runner = {
      exec: async (argv: readonly string[]) => {
        commands.push([...argv]);
        if (argv[1] === "workspace" && argv[2] === "create") {
          return ok({ result: { root_pane: { pane_id: "p1" }, workspace: { workspace_id: "w1" } } });
        }
        return ok({});
      },
    };
    const options: HerdrWorkerOptions = {
      workDir: "/repo",
      runner,
      // All three would be dangerous if interpolated raw: a non-numeric string
      // (command injection) and out-of-range/non-finite numbers.
      timeoutMs: "5000; rm -rf /" as unknown as number,
      startTimeoutMs: Number.NaN,
      readLines: "999999" as unknown as number,
    };
    const harvest = await runHerdrWorker(options, "worker-sanitize", "prompt");
    expect(harvest.ok).toBe(true);

    const start = commands.find((argv) => argv[2] === "start");
    const prompt = commands.find((argv) => argv[2] === "prompt");
    const read = commands.find((argv) => argv[2] === "read");
    // Non-finite string -> default, capped; NaN -> default; numeric string -> capped.
    expect(start?.includes("--timeout")).toBe(true);
    expect(start?.[start.indexOf("--timeout") + 1]).toBe("120000");
    expect(prompt?.includes("rm -rf")).toBe(false);
    expect(prompt?.[prompt.indexOf("--timeout") + 1]).toBe("300000");
    expect(read).toEqual([
      "herdr",
      "agent",
      "read",
      "worker-sanitize",
      "--source",
      "recent-unwrapped",
      "--lines",
      "10000",
    ]);
  });
});

describe("herdr worker executor — agent kind defaults", () => {
  const okRunner = (commands: string[][]) =>
    ({
      exec: async (argv: readonly string[]) => {
        commands.push([...argv]);
        if (argv[1] === "workspace" && argv[2] === "create") {
          return {
            stdout: JSON.stringify({ result: { root_pane: { pane_id: "p1" }, workspace: { workspace_id: "w1" } } }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    }) satisfies import("@guyghost/swarm-dao-herdr-adapter").HerdrRunner;

  const startOf = (commands: string[][]): string[] =>
    commands.find((argv) => argv[2] === "start") ?? [];

  it("defaults to '-ne' only for the pi kind (raw argv behind the separator)", async () => {
    const piCommands: string[][] = [];
    const pi = await runHerdrWorker({ workDir: "/repo", runner: okRunner(piCommands) }, "worker-pi", "prompt");
    expect(pi.ok).toBe(true);
    expect(startOf(piCommands).slice(-2)).toEqual(["--", "-ne"]);

    const codexCommands: string[][] = [];
    const codex = await runHerdrWorker({ workDir: "/repo", kind: "codex", runner: okRunner(codexCommands) }, "w", "p");
    expect(codex.ok).toBe(true);
    expect(startOf(codexCommands)).not.toContain("-ne");
  });

  it("explicit agentArgs override the kind default", async () => {
    const commands: string[][] = [];
    const harvest = await runHerdrWorker(
      { workDir: "/repo", kind: "claude", agentArgs: ["--permission-mode", "read-only"], runner: okRunner(commands) },
      "worker-claude",
      "prompt",
    );
    expect(harvest.ok).toBe(true);
    const start = startOf(commands);
    const sep = start.indexOf("--");
    expect(start.slice(sep + 1)).toEqual(["--permission-mode", "read-only"]);
  });
});

describe("herdr worker executor — orphaned workspace cleanup (dogfood-003 c6 finding)", () => {
  const ok = (stdout: unknown) => ({ stdout: JSON.stringify(stdout), stderr: "", exitCode: 0 });

  it("closes a lingering same-label workspace before creating a fresh one", async () => {
    const commands: string[][] = [];
    const runner = {
      exec: async (argv: readonly string[]) => {
        commands.push([...argv]);
        if (argv[1] === "workspace" && argv[2] === "list") {
          return ok({
            result: {
              workspaces: [
                { label: "~", workspace_id: "wHome" },
                { label: "orchestrator-sensor", workspace_id: "wOrphan" },
                { label: "orchestrator-sensor-r1", workspace_id: "wOrphanRetry" },
                { label: "someone-elses", workspace_id: "wOther" },
              ],
            },
          });
        }
        if (argv[1] === "workspace" && argv[2] === "create") {
          return ok({ result: { root_pane: { pane_id: "p1" }, workspace: { workspace_id: "w1" } } });
        }
        return ok({});
      },
    };

    const harvest = await runHerdrWorker({ workDir: "/repo", runner }, "orchestrator-sensor", "prompt");
    expect(harvest.ok).toBe(true);

    const closeIndex = commands.findIndex((argv) => argv[2] === "close" && argv[3] === "wOrphan");
    const closeRetryIndex = commands.findIndex((argv) => argv[2] === "close" && argv[3] === "wOrphanRetry");
    const createIndex = commands.findIndex((argv) => argv[2] === "create");
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeRetryIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(createIndex);
    expect(closeRetryIndex).toBeLessThan(createIndex);
    // Unrelated workspaces (the operator's own, other labels) stay untouched.
    expect(commands.some((argv) => argv[2] === "close" && argv[3] === "wHome")).toBe(false);
    expect(commands.some((argv) => argv[2] === "close" && argv[3] === "wOther")).toBe(false);
  });

  it("tolerates a failing workspace list without breaking the run", async () => {
    const commands: string[][] = [];
    const runner = {
      exec: async (argv: readonly string[]) => {
        commands.push([...argv]);
        if (argv[1] === "workspace" && argv[2] === "list") return { stdout: "", stderr: "boom", exitCode: 1 };
        if (argv[1] === "workspace" && argv[2] === "create") {
          return ok({ result: { root_pane: { pane_id: "p1" }, workspace: { workspace_id: "w1" } } });
        }
        return ok({});
      },
    };

    const harvest = await runHerdrWorker({ workDir: "/repo", runner }, "orchestrator-sensor", "prompt");
    expect(harvest.ok).toBe(true);
    expect(commands.some((argv) => argv[2] === "create")).toBe(true);
  });
});
