import { afterEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGitHubConfigFromDaoRoot, saveGitHubConfigToDaoRoot } from "../src/host-tools/github-config.js";
import { getGitHubConfig, isGitHubEnabled } from "../src/integrations/github.js";

describe("host-tools/github-config.ts", () => {
  it("restores the live token from DAO_GITHUB_TOKEN when the persisted one is redacted", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-ghcfg-"));
    try {
      await saveGitHubConfigToDaoRoot(daoRoot, { token: "ghp_live", owner: "acme", repo: "app" });
      // The persisted copy is redacted...
      const persisted = JSON.parse(await fs.readFile(path.join(daoRoot, "config.json"), "utf8"));
      expect(persisted.github.token).toBe("[REDACTED]");

      // ...so without an env token a fresh process cannot enable the integration.
      delete process.env.DAO_GITHUB_TOKEN;
      expect(await loadGitHubConfigFromDaoRoot(daoRoot)).toBe(false);

      // With DAO_GITHUB_TOKEN set, the redacted literal must never be sent as
      // a credential; the env token is used instead.
      process.env.DAO_GITHUB_TOKEN = "ghp_env";
      expect(await loadGitHubConfigFromDaoRoot(daoRoot)).toBe(true);
      expect(isGitHubEnabled()).toBe(true);
      expect(getGitHubConfig()?.token).toBe("ghp_env");
      expect(getGitHubConfig()?.owner).toBe("acme");
    } finally {
      delete process.env.DAO_GITHUB_TOKEN;
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("uses a persisted plaintext token when present", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-ghcfg-"));
    try {
      await fs.writeFile(
        path.join(daoRoot, "config.json"),
        JSON.stringify({ github: { token: "ghp_plain", owner: "o", repo: "r", enabled: true } }),
      );
      delete process.env.DAO_GITHUB_TOKEN;
      expect(await loadGitHubConfigFromDaoRoot(daoRoot)).toBe(true);
      expect(getGitHubConfig()?.token).toBe("ghp_plain");
    } finally {
      delete process.env.DAO_GITHUB_TOKEN;
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    delete process.env.DAO_GITHUB_TOKEN;
  });
});
