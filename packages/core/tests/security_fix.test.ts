import { afterEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LogLevel, setLogHandler } from "../src/observability/logging.js";
import { loadProposalsFromDisk } from "../src/persistence.js";

describe("Security Fix: generic JSON parse errors", () => {
  let capturedLogs: { level: LogLevel; message: string }[] = [];

  afterEach(() => {
    setLogHandler(null); // Reset to default (which console.log/warns)
    capturedLogs = [];
  });

  it("should not include malformed content in log messages when parsing fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-security-test-"));
    const proposalsDir = path.join(tmpDir, "proposals");
    await fs.mkdir(proposalsDir, { recursive: true });

    // Create a malformed proposal sidecar that contains a "secret" string
    const sensitiveValue = "REALLY_SECRET_DATA_THAT_SHOULD_NOT_LEAK";
    const malformedJson = `{"id": 1, "token": "${sensitiveValue}", "malformed": `; // Unexpected end of JSON

    await fs.writeFile(path.join(proposalsDir, "001.json"), malformedJson);

    // Set up log capture
    setLogHandler((level, message) => {
      capturedLogs.push({ level, message });
    });

    try {
      // loadProposalsFromDisk logs a warning when it encounters a malformed sidecar
      await loadProposalsFromDisk(tmpDir);

      const logEntry = capturedLogs.find((l) => l.level === "warn" && l.message.includes("001.json"));
      expect(logEntry).toBeDefined();

      const message = logEntry?.message;

      // Should mention it's malformed and provide the generic "Invalid JSON" message
      expect(message).toContain("Skipping malformed proposal sidecar");
      expect(message).toContain("Invalid JSON");

      // CRITICAL: Should NOT contain the sensitive value
      expect(message).not.toContain(sensitiveValue);

      // Should NOT contain the low-level JSON parse error snippets
      expect(message).not.toContain("JSON Parse error");
      expect(message).not.toContain("Unexpected EOF");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
