import { describe, expect, it } from "bun:test";
import {
  buildSandboxCommand,
  createSandboxRunCommand,
  resolveSandboxMode,
  resolveSandboxRunCommand,
  validateSandboxImage,
} from "../src/sandbox.js";

const fakeRunner =
  (log: string[], exitCode = 0) =>
  async (command: string) => {
    log.push(command);
    return { stdout: "", stderr: "", exitCode };
  };

describe("improvement-loop — bounded sandbox execution", () => {
  it("validates image references fail-closed", () => {
    expect(validateSandboxImage("node:22-bookworm")).toBeNull();
    expect(validateSandboxImage("ghcr.io/owner/repo:tag")).toBeNull();
    expect(validateSandboxImage("alpine@sha256:deadbeef")).not.toBeNull(); // short digest rejected
    expect(validateSandboxImage("node; rm -rf /")).not.toBeNull();
    expect(validateSandboxImage("node extra")).not.toBeNull();
    expect(validateSandboxImage("")).not.toBeNull();
  });

  it("builds docker/container commands with network off, mount, limits and quoting", () => {
    const base = { mode: "docker" as const, image: "node:22", workDir: "/repo root" };
    const docker = buildSandboxCommand(base, "npm test");
    expect(docker).toContain("docker run --rm --network none");
    expect(docker).toContain("--cpus 2");
    expect(docker).toContain("--memory 2048M");
    expect(docker).toContain("-v '/repo root:/workspace'"); // quoted pair, spaces safe
    expect(docker).toContain("-w /workspace");
    expect(docker).toContain("node:22 sh -c");

    const apple = buildSandboxCommand({ ...base, mode: "container", cpus: 4, memoryMb: 8192 }, "bun test");
    expect(apple.startsWith("container run --rm --network none")).toBe(true);
    expect(apple).toContain("--cpus 4");
    expect(apple).toContain("--memory 8192M");
    expect(apple).toContain("sh -c 'bun test'");
  });

  it("rejects relative workDir and hostile images before any shell sees them", () => {
    expect(() => buildSandboxCommand({ mode: "docker", image: "ok", workDir: "relative/path" }, "x")).toThrow(
      /absolute host path/,
    );
    expect(() => buildSandboxCommand({ mode: "docker", image: "a$(b)", workDir: "/r" }, "x")).toThrow(
      /not a plain OCI reference/,
    );
  });

  it("executes through the injected runner and reports failures as outcomes", async () => {
    const log: string[] = [];
    const okRunner = createSandboxRunCommand({ mode: "docker", image: "node:22", workDir: "/repo" }, fakeRunner(log));
    const outcome = await okRunner("bun test");
    expect(outcome.ok).toBe(true);
    expect(log[0]).toContain("docker run");

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
