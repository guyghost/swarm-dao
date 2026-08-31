import { describe, expect, it } from "bun:test";
import { type HerdrWorkerOptions, runHerdrWorker, toBoundedInt } from "../workers.js";

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
    const commands: string[] = [];
    const ok = (stdout: unknown) => ({ stdout: JSON.stringify(stdout), stderr: "", exitCode: 0 });
    const runner = {
      exec: async (command: string) => {
        commands.push(command);
        if (command.startsWith("herdr workspace create")) {
          return ok({ result: { root_pane: { pane_id: "p1" }, workspace: { workspace_id: "w1" } } });
        }
        return ok({});
      },
    };
    const options: HerdrWorkerOptions = {
      workDir: "/repo",
      runner,
      // All three would be dangerous if interpolated raw: a non-numeric string
      // (shell injection) and out-of-range/non-finite numbers.
      timeoutMs: "5000; rm -rf /" as unknown as number,
      startTimeoutMs: Number.NaN,
      readLines: "999999" as unknown as number,
    };
    const harvest = await runHerdrWorker(options, "worker-sanitize", "prompt");
    expect(harvest.ok).toBe(true);

    const promptCommand = commands.find((command) => command.startsWith("herdr agent prompt"));
    expect(promptCommand).toContain("--timeout 300000"); // non-finite string -> default, capped
    expect(promptCommand).not.toContain("rm -rf");
    const startCommand = commands.find((command) => command.startsWith("herdr agent start"));
    expect(startCommand).toContain("--timeout 120000"); // NaN -> default
    const readCommand = commands.find((command) => command.startsWith("herdr agent read"));
    expect(readCommand).toBe("herdr agent read worker-sanitize --source recent-unwrapped --lines 10000"); // numeric string -> capped at ceiling
  });
});
