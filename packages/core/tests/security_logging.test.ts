import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setLogHandler } from "../src/observability/logging.js";
import { updateStorageSettings } from "../src/persistence.js";

describe("Security Logging", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-dao-security-test-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
    mock.restore();
    setLogHandler(null); // Disable custom logger
  });

  it("should redact sensitive information in logs if it appears in error messages", async () => {
    const originalReadFile = fs.readFile;
    // @ts-expect-error
    fs.readFile = mock(async () => {
      throw new Error('Failed to read config: secret=my-secret-value, "secret": "json-secret-value"');
    });

    const warnSpy = mock();
    setLogHandler((level, message) => {
      if (level === "warn") warnSpy(message);
    });

    try {
      await updateStorageSettings(tmpDir, { mode: "local" });
    } catch (_e) {
      // Expected
    } finally {
      // @ts-expect-error
      fs.readFile = originalReadFile;
    }

    const calls = warnSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    const logMessages = calls.map((call) => String(call[0]));
    expect(logMessages.some((message) => message.includes("my-secret-value"))).toBe(false);
    expect(logMessages.some((message) => message.includes("json-secret-value"))).toBe(false);
    expect(logMessages.some((message) => message.includes("secret=[REDACTED]"))).toBe(true);
    expect(logMessages.some((message) => message.includes('"secret": "[REDACTED]"'))).toBe(true);
  });
});
