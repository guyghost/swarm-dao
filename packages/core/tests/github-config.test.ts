import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGitHubConfigFromDaoRoot, saveGitHubConfigToDaoRoot } from "../src/host-tools/github-config.js";
import { configureGitHub, getGitHubConfig, isGitHubEnabled } from "../src/integrations/github.js";

describe("host-tools/github-config.ts", () => {
  it("persists owner/repo and the issues opt-in without any token", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-ghcfg-"));
    try {
      await saveGitHubConfigToDaoRoot(daoRoot, { owner: "acme", repo: "app", issues: true });

      const persisted = JSON.parse(await fs.readFile(path.join(daoRoot, "config.json"), "utf8"));
      expect(persisted.github).toEqual({ owner: "acme", repo: "app", enabled: true, issues: true });
      expect(JSON.stringify(persisted)).not.toContain("token");

      // A fresh load configures the integration without any credential.
      configureGitHub({ enabled: false, owner: undefined, repo: undefined });
      expect(await loadGitHubConfigFromDaoRoot(daoRoot)).toBe(true);
      expect(isGitHubEnabled()).toBe(true);
      expect(getGitHubConfig()?.owner).toBe("acme");
      expect(getGitHubConfig()?.repo).toBe("app");
      expect(getGitHubConfig()?.issues).toBe(true);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("defaults issues to false", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-ghcfg-"));
    try {
      await saveGitHubConfigToDaoRoot(daoRoot, { owner: "acme", repo: "app" });

      const persisted = JSON.parse(await fs.readFile(path.join(daoRoot, "config.json"), "utf8"));
      expect(persisted.github.issues).toBe(false);

      await loadGitHubConfigFromDaoRoot(daoRoot);
      expect(getGitHubConfig()?.issues).toBe(false);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });

  it("stays unconfigured without owner/repo", async () => {
    const daoRoot = await fs.mkdtemp(path.join(tmpdir(), "swarm-dao-ghcfg-"));
    try {
      await fs.writeFile(path.join(daoRoot, "config.json"), JSON.stringify({ github: { repo: "r" } }));
      expect(await loadGitHubConfigFromDaoRoot(daoRoot)).toBe(false);
    } finally {
      await fs.rm(daoRoot, { recursive: true, force: true });
    }
  });
});
