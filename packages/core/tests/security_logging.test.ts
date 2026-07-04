import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setLogHandler } from "../src/observability/logging.js";
import { sanitizeErrorMessage, updateStorageSettings } from "../src/persistence.js";

const SECRET_VALUE = "my-secret-value";
const PASSWORD_VALUE = "json-password-value";

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
      throw new Error(`Failed to read config: secret=${SECRET_VALUE}, "password": "${PASSWORD_VALUE}"`);
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
    expect(logMessages.some((message) => message.includes(SECRET_VALUE))).toBe(false);
    expect(logMessages.some((message) => message.includes(PASSWORD_VALUE))).toBe(false);
    const relevantMessages = logMessages.filter(
      (message) => message.includes("secret=") || message.includes('"password":'),
    );
    expect(relevantMessages.length).toBeGreaterThan(0);
    expect(relevantMessages.every((message) => message.includes("secret=[REDACTED]"))).toBe(true);
    expect(relevantMessages.every((message) => message.includes('"password": "[REDACTED]"'))).toBe(true);
  });
});

describe("sanitizeErrorMessage", () => {
  // Table-driven coverage of every sensitive-key redaction shape. Cases are
  // chosen so that a mis-compiled regex (missing `i`/`g` flag, broken word
  // boundaries, broken quote alternation, broken separator) would fail.
  const CASES: ReadonlyArray<{ name: string; input: string; expected: string }> = [
    { name: "bare token=value", input: "token=abc", expected: "token=[REDACTED]" },
    { name: "colon separator with spaces", input: "token: abc", expected: "token: [REDACTED]" },
    { name: "double-quoted JSON secret", input: `"secret":"x"`, expected: `"secret":"[REDACTED]"` },
    { name: "single-quoted password", input: `'password':'y'`, expected: `'password':'[REDACTED]'` },
    { name: "apikey bare value", input: "apikey: z", expected: "apikey: [REDACTED]" },
    { name: "key with special-char bare value", input: "key=a/b+c@d", expected: "key=[REDACTED]" },
    { name: "case-insensitive uppercase key (i flag)", input: "TOKEN=abc", expected: "TOKEN=[REDACTED]" },
    { name: "case-insensitive mixed-case key (i flag)", input: "Secret=abc", expected: "Secret=[REDACTED]" },
    {
      name: "key appears multiple times (g flag)",
      input: "token=a token=b",
      expected: "token=[REDACTED] token=[REDACTED]",
    },
    { name: "quoted value containing comma and brace", input: `secret="a,b}c"`, expected: `secret="[REDACTED]"` },
    { name: "bare value terminates at comma", input: "secret=a,b", expected: "secret=[REDACTED],b" },
    { name: "no sensitive content is unchanged", input: "hello world 123", expected: "hello world 123" },
    { name: "word boundary: keyboard is not redacted", input: "keyboard=abc", expected: "keyboard=abc" },
    { name: "word boundary: monkey is not redacted", input: "monkey=abc", expected: "monkey=abc" },
    {
      name: "multiple distinct keys in one message",
      input: "token=abc secret=xyz",
      expected: "token=[REDACTED] secret=[REDACTED]",
    },
    { name: "quoted key with bare value", input: `"key": barevalue`, expected: `"key": [REDACTED]` },
    {
      name: "apikey key does not partial-match the key pattern",
      input: "apikey=topsecret",
      expected: "apikey=[REDACTED]",
    },
  ];

  for (const { name, input, expected } of CASES) {
    it(`redacts: ${name}`, () => {
      expect(sanitizeErrorMessage(input)).toBe(expected);
    });
  }

  // Regression: the per-key regexes are now compiled once at module load and
  // reused across calls. With the `g` flag, String.prototype.replace neither
  // reads nor mutates lastIndex, so reuse must remain correct and stable no
  // matter how many times the function runs.
  it("is stable across many repeated calls (regex reuse safety)", () => {
    const input = `token=a secret=b password=c "key":"d" apikey=e monkey=f`;
    const first = sanitizeErrorMessage(input);
    for (let i = 0; i < 50; i++) {
      expect(sanitizeErrorMessage(input)).toBe(first);
    }
    // Sanity: the redaction actually happened (and the word-boundary `monkey=f` survived).
    expect(first).toBe(
      `token=[REDACTED] secret=[REDACTED] password=[REDACTED] "key":"[REDACTED]" apikey=[REDACTED] monkey=f`,
    );
  });
});
