import { promises as fs } from "node:fs";
import path from "node:path";
import { configureGitHub, isGitHubEnabled } from "../integrations/github.js";

export async function loadGitHubConfigFromDaoRoot(daoRoot: string): Promise<boolean> {
  const configPath = path.join(daoRoot, "config.json");
  try {
    const configData = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      github?: { owner?: string; repo?: string; enabled?: boolean; token?: string };
    };
    const github = configData.github;
    if (github?.owner && github?.repo) {
      configureGitHub({ ...github, enabled: github.enabled ?? true });
      return isGitHubEnabled();
    }
  } catch {
    // no config file
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
  } catch {
    // no existing config
  }
  configData.github = { ...githubConfig, enabled: true, token: "[REDACTED]" };
  await fs.writeFile(configPath, JSON.stringify(configData, null, 2), "utf-8");
  configureGitHub({ ...githubConfig, enabled: true });
}
