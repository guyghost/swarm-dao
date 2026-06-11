import { afterEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ProjectConfig, redactSensitiveFields, saveConfig } from "@guyghost/swarm-dao-core";

describe("security", () => {
  const tmpDir = path.join(os.tmpdir(), `swarm-dao-test-${Math.random().toString(36).slice(2)}`);

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("redacts sensitive fields", () => {
    const config = {
      github: { token: "secret-token", owner: "guyghost" },
      nested: {
        password: "my-password",
        other: "value",
      },
      apiKey: "some-key",
      normal: "field",
    };

    const redacted = redactSensitiveFields(config);
    expect(redacted.github.token).toBe("[REDACTED]");
    expect(redacted.nested.password).toBe("[REDACTED]");
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.normal).toBe("field");
  });

  it("saveConfig redacts tokens in the file", async () => {
    const config: ProjectConfig = {
      mode: "opt-in",
      github: {
        enabled: true,
        owner: "o",
        repo: "r",
        token: "super-secret",
      } as unknown as ProjectConfig["github"],
    };

    await saveConfig(tmpDir, config);
    const configPath = path.join(tmpDir, "config.json");
    const data = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(data);

    expect(parsed.github.token).toBe("[REDACTED]");
  });

  it("integrations use environment variables when token is redacted", async () => {
    const { configureGitHub, isGitHubEnabled } = await import("../src/integrations/github.js");

    // Set up with redacted token
    configureGitHub({ enabled: true, token: "[REDACTED]", owner: "o", repo: "r" });

    // Without env var, it should be disabled
    const oldEnv = process.env.DAO_GITHUB_TOKEN;
    delete process.env.DAO_GITHUB_TOKEN;
    expect(isGitHubEnabled()).toBe(false);

    // With env var, it should be enabled
    process.env.DAO_GITHUB_TOKEN = "env-token";
    expect(isGitHubEnabled()).toBe(true);

    // Clean up
    if (oldEnv) process.env.DAO_GITHUB_TOKEN = oldEnv;
    else delete process.env.DAO_GITHUB_TOKEN;
  });
});
