import { describe, expect, it } from "bun:test";
import {
  buildSandboxArgv,
  createSandboxRunCommand,
  resolveSandboxMode,
  resolveSandboxRunCommand,
  validateSandboxImage,
} from "../src/sandbox.js";

const fakeRunner =
  (log: string[][], exitCode = 0) =>
  async (argv: readonly string[]) => {
    log.push([...argv]);
    return { stdout: "", stderr: "", exitCode };
  };

/** Joined argv form for readable assertions — the runner receives ARGV. */
const line = (argv: readonly string[] | undefined): string => (argv ?? []).join(" ");

describe("improvement-loop — bounded sandbox execution", () => {
  it("validates image references fail-closed", () => {
    expect(validateSandboxImage("node:22-bookworm")).toBeNull();
    expect(validateSandboxImage("ghcr.io/owner/repo:tag")).toBeNull();
    expect(validateSandboxImage("alpine@sha256:deadbeef")).not.toBeNull(); // short digest rejected
    expect(validateSandboxImage("node; rm -rf /")).not.toBeNull();
    expect(validateSandboxImage("node extra")).not.toBeNull();
    expect(validateSandboxImage("")).not.toBeNull();
  });

  it("builds docker/container ARGV with network off, mount, limits — no shell quoting needed", () => {
    const base = { runtime: "docker" as const, image: "node:22", workDir: "/repo root" };
    const docker = buildSandboxArgv(base, "npm test");
    expect(line(docker).startsWith("docker run --rm --network none")).toBe(true);
    expect(docker).toContain("--cpus");
    expect(docker).toContain("2");
    expect(docker).toContain("--memory");
    expect(docker).toContain("2048M");
    expect(docker).toContain("-v");
    expect(docker).toContain("/repo root:/workspace"); // raw argv element, spaces safe
    expect(docker).toContain("-w");
    expect(docker).toContain("/workspace");
    expect(line(docker)).toContain("node:22 sh -c");

    const apple = buildSandboxArgv({ ...base, runtime: "container", cpus: 4, memoryMb: 8192 }, "bun test");
    expect(apple[0]).toBe("container");
    expect(apple).toContain("--cpus");
    expect(apple).toContain("4");
    expect(apple).toContain("--memory");
    expect(apple).toContain("8192M");
    expect(apple.slice(-3)).toEqual(["sh", "-c", "bun test"]);
  });

  it("rejects relative workDir and hostile images before any shell sees them", () => {
    expect(() => buildSandboxArgv({ mode: "docker", image: "ok", workDir: "relative/path" }, "x")).toThrow(
      /absolute host path/,
    );
    expect(() => buildSandboxArgv({ mode: "docker", image: "a$(b)", workDir: "/r" }, "x")).toThrow(
      /not a plain OCI reference/,
    );
  });

  it("executes through the injected runner and reports failures as outcomes", async () => {
    const log: string[][] = [];
    const okRunner = createSandboxRunCommand({ mode: "docker", image: "node:22", workDir: "/repo" }, fakeRunner(log));
    const outcome = await okRunner("bun test");
    expect(outcome.ok).toBe(true);
    expect(line(log[0]).startsWith("docker run --rm --network none")).toBe(true);
    expect(log[0]?.slice(-3)).toEqual(["sh", "-c", "bun test"]);

    const failing = createSandboxRunCommand({ mode: "docker", image: "node:22", workDir: "/repo" }, async () => ({
      stdout: "42 tests failed",
      stderr: "exit code 1",
      exitCode: 1,
    }));
    const failure = await failing("bun test");
    expect(failure.ok).toBe(false);
    expect(failure.detail).toContain("42 tests failed");
  });

  it("auto-detects container before docker and throws when neither exists", async () => {
    const pick = (first: number) => {
      let probes = 0;
      return async () => {
        probes++;
        return { stdout: "", stderr: "", exitCode: probes >= first ? 0 : 1 };
      };
    };
    expect(await resolveSandboxMode("auto", pick(1))).toBe("container");
    expect(await resolveSandboxMode("auto", pick(2))).toBe("docker");
    await expect(resolveSandboxMode("auto", pick(99))).rejects.toThrow(/neither Apple container nor Docker/);
    expect(await resolveSandboxMode("none", pick(99))).toBeNull();
  });

  it("resolveSandboxRunCommand returns null for none and demands an image otherwise", async () => {
    expect(await resolveSandboxRunCommand({ sandbox: "none" }, "/repo", fakeRunner([]))).toBeNull();
    await expect(resolveSandboxRunCommand({ sandbox: "docker" }, "/repo", fakeRunner([]))).rejects.toThrow(
      /sandbox execution requires an image/,
    );
    const runner = await resolveSandboxRunCommand({ sandbox: "container", image: "node:22" }, "/repo", fakeRunner([]));
    expect(runner).not.toBeNull();
  });
});
