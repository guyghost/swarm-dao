import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Hermetic unit tests: child-session linkage defaults come from the host
// environment (HERDR_WORKSPACE_ID when this process runs inside a herdr
// pane) — pin it off; linkage tests pass explicit parent ids.
process.env.HERDR_ENV = "0";
delete process.env.HERDR_WORKSPACE_ID;

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

  const startOf = (commands: string[][]): string[] => commands.find((argv) => argv[2] === "start") ?? [];

  it("defaults to '-ne' only for the pi kind (raw argv behind the separator)", async () => {
    // Reporter path pinned to a missing file so the base default is
    // deterministic on every machine; both reporter branches have dedicated
    // tests above.
    const piCommands: string[][] = [];
    const pi = await runHerdrWorker(
      { workDir: "/repo", piStateReporterPath: "/nonexistent/herdr-agent-state.ts", runner: okRunner(piCommands) },
      "worker-pi",
      "prompt",
    );
    expect(pi.ok).toBe(true);
    expect(startOf(piCommands).slice(-2)).toEqual(["--", "-ne"]);

    const codexCommands: string[][] = [];
    const codex = await runHerdrWorker({ workDir: "/repo", kind: "codex", runner: okRunner(codexCommands) }, "w", "p");
    expect(codex.ok).toBe(true);
    expect(startOf(codexCommands)).not.toContain("-ne");
  });

  it("loads herdr's pi state reporter explicitly despite -ne when it is installed", async () => {
    // Verified live: with plain '-ne' the herdr state integration never loads,
    // the pi screen manifest matches nothing on a fast worker pane, and every
    // 'agent prompt --wait' trips agent_prompt_stalled with a frozen
    // state_change_seq. '-ne' keeps discovery off but explicit '-e' still works,
    // so the reporter must be appended by path. Any existing file path works
    // here — the executor only checks existence.
    const reporterPath = `${import.meta.dir}/workers.test.ts`;
    const commands: string[][] = [];
    const harvest = await runHerdrWorker(
      { workDir: "/repo", piStateReporterPath: reporterPath, runner: okRunner(commands) },
      "worker-reporter",
      "prompt",
    );
    expect(harvest.ok).toBe(true);
    expect(startOf(commands).slice(-4)).toEqual(["--", "-ne", "-e", reporterPath]);
  });

  it("keeps plain '-ne' when the herdr state reporter is not installed", async () => {
    const commands: string[][] = [];
    const harvest = await runHerdrWorker(
      { workDir: "/repo", piStateReporterPath: "/nonexistent/herdr-agent-state.ts", runner: okRunner(commands) },
      "worker-no-reporter",
      "prompt",
    );
    expect(harvest.ok).toBe(true);
    expect(startOf(commands).slice(-2)).toEqual(["--", "-ne"]);
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

describe("herdr worker executor — child session linkage (parent workspace)", () => {
  let plainDir: string;
  let worktreeDir: string;

  const CREATED = JSON.stringify({
    result: { root_pane: { pane_id: "p9" }, workspace: { workspace_id: "w9" } },
  });
  const OPENED = JSON.stringify({
    result: { root_pane: { pane_id: "p3" }, workspace: { workspace_id: "w3" } },
  });

  beforeAll(async () => {
    plainDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-worker-plain-"));
    worktreeDir = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-worker-wtree-"));
    // A registered worktree checkout carries a .git FILE, not a directory.
    await fs.writeFile(path.join(worktreeDir, ".git"), "gitdir: /tmp/elsewhere/.git/worktrees/probe\n");
  });

  afterAll(async () => {
    await fs.rm(plainDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  const linker = (openExitCode = 0) => {
    const commands: string[][] = [];
    const runner = {
      exec: async (argv: readonly string[]) => {
        commands.push([...argv]);
        if (argv[2] === "open")
          return { stdout: OPENED, stderr: openExitCode === 0 ? "" : "boom", exitCode: openExitCode };
        if (argv[2] === "create") return { stdout: CREATED, stderr: "", exitCode: 0 };
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    };
    return { commands, runner };
  };

  it("opens series-worktree workers as workspaces linked to the parent", async () => {
    const { commands, runner } = linker();
    const harvest = await runHerdrWorker(
      { workDir: worktreeDir, parentWorkspaceId: "wParent", runner },
      "orchestrator-sensor",
      "prompt",
    );
    expect(harvest.ok).toBe(true);
    expect(commands.some((argv) => argv.slice(0, 3).join(" ") === "herdr worktree open")).toBe(true);
    expect(commands.some((argv) => argv[2] === "create")).toBe(false);
    // The lifecycle continues inside the opened (linked) workspace.
    expect(commands.some((argv) => argv[argv.indexOf("--pane") + 1] === "p3")).toBe(true);
    expect(commands.some((argv) => argv[2] === "close" && argv[3] === "w3")).toBe(true);
  });

  it("falls back to a plain workspace when the worktree open fails", async () => {
    const { commands, runner } = linker(1);
    const harvest = await runHerdrWorker(
      { workDir: worktreeDir, parentWorkspaceId: "wParent", runner },
      "orchestrator-sensor",
      "prompt",
    );
    expect(harvest.ok).toBe(true);
    expect(commands.map((argv) => argv[2])).toContain("create");
    expect(commands.some((argv) => argv[argv.indexOf("--pane") + 1] === "p9")).toBe(true);
  });

  it("tags same-checkout workers with a parent provenance token", async () => {
    const { commands, runner } = linker();
    const harvest = await runHerdrWorker(
      { workDir: plainDir, parentWorkspaceId: "wParent", runner },
      "orchestrator-sensor",
      "prompt",
    );
    expect(harvest.ok).toBe(true);
    const metadata = commands.find((argv) => argv[2] === "report-metadata");
    expect(metadata).toBeDefined();
    expect(metadata?.includes("parent=wParent")).toBe(true);
  });

  it("spawns plain workspaces when no parent session is detectable", async () => {
    const { commands, runner } = linker();
    const harvest = await runHerdrWorker({ workDir: plainDir, runner }, "orchestrator-sensor", "prompt");
    expect(harvest.ok).toBe(true);
    expect(commands.some((argv) => argv[2] === "open")).toBe(false);
    expect(commands.some((argv) => argv[2] === "report-metadata")).toBe(false);
  });
});
