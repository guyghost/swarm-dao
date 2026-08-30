import { promises as fs } from "node:fs";
import path from "node:path";
import { configureGitHub, isGitHubEnabled } from "../integrations/github.js";
import { logger } from "../observability/logging.js";

export async function loadGitHubConfigFromDaoRoot(daoRoot: string): Promise<boolean> {
  const configPath = path.join(daoRoot, "config.json");
  try {
    const configData = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      github?: { owner?: string; repo?: string; enabled?: boolean; token?: string };
    };
    const github = configData.github;
    if (github?.owner && github?.repo) {
      // The persisted token is redacted on save; the live token comes from
      // DAO_GITHUB_TOKEN (the mechanism the config output advertises). A
      // redacted literal must never be sent as a credential.
      const persisted = typeof github.token === "string" ? github.token : undefined;
      const token = persisted && persisted !== "[REDACTED]" ? persisted : process.env.DAO_GITHUB_TOKEN;
      if (!token) {
        logger.debug("loadGitHubConfigFromDaoRoot: token redacted and DAO_GITHUB_TOKEN not set");
        return false;
      }
      configureGitHub({ owner: github.owner, repo: github.repo, token, enabled: github.enabled ?? true });
      return isGitHubEnabled();
    }
  } catch (error) {
    // Missing or invalid config is a normal cold-start state; log at debug.
    logger.debug("loadGitHubConfigFromDaoRoot: no config (%s)", error instanceof Error ? error.message : String(error));
  }
  return false;
}

export async function saveGitHubConfigToDaoRoot(
  daoRoot: string,
  githubConfig: { token: string; owner: string; repo: string },
): Promise<void> {
  await fs.mkdir(daoRoot, { recursive: true });
  const configPath = path.join(daoRoot, "config.json");
  let configData: Record<string, unknown> = {};
  try {
    configData = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    // No existing config yet; this is expected on first write.
    logger.debug(
      "saveGitHubConfigToDaoRoot: starting fresh config (%s)",
      error instanceof Error ? error.message : String(error),
    );
  }
  configData.github = { ...githubConfig, enabled: true, token: "[REDACTED]" };
  await fs.writeFile(configPath, JSON.stringify(configData, null, 2), "utf-8");
  configureGitHub({ ...githubConfig, enabled: true });
}
