import { promises as fs } from "node:fs";
import path from "node:path";
import { configureGitHub, isGitHubEnabled } from "../integrations/github.js";
import { logger } from "../observability/logging.js";

export interface DaoGitHubConfig {
  owner: string;
  repo: string;
  /** Track proposal modifications as GitHub issues. */
  issues?: boolean;
}

export async function loadGitHubConfigFromDaoRoot(daoRoot: string): Promise<boolean> {
  const configPath = path.join(daoRoot, "config.json");
  try {
    const configData = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      github?: { owner?: string; repo?: string; enabled?: boolean; issues?: boolean };
    };
    const github = configData.github;
    if (github?.owner && github?.repo) {
      // No credentials are stored or read here: authentication is delegated
      // to the `gh` CLI (the user authenticates once via `gh auth login`).
      configureGitHub({
        owner: github.owner,
        repo: github.repo,
        enabled: github.enabled ?? true,
        issues: github.issues === true,
      });
      return isGitHubEnabled();
    }
  } catch (error) {
    // Missing or invalid config is a normal cold-start state; log at debug.
    logger.debug("loadGitHubConfigFromDaoRoot: no config (%s)", error instanceof Error ? error.message : String(error));
  }
  return false;
}

export async function saveGitHubConfigToDaoRoot(daoRoot: string, githubConfig: DaoGitHubConfig): Promise<void> {
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
  configData.github = {
    owner: githubConfig.owner,
    repo: githubConfig.repo,
    enabled: true,
    issues: githubConfig.issues === true,
  };
  await fs.writeFile(configPath, JSON.stringify(configData, null, 2), "utf-8");
  configureGitHub({ ...githubConfig, enabled: true });
}
