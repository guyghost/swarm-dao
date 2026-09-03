// ============================================================
// Swarm DAO Core — GitHub Integration (via the `gh` CLI)
// ============================================================
//
// Authentication is delegated to the GitHub CLI: the user runs
// `gh auth login` once and Swarm DAO never stores or transmits
// tokens. Every API call is a `gh api` subprocess, so credentials
// are managed entirely by `gh`.

import { spawn } from "node:child_process";
import { logger } from "../observability/logging.js";
import type { Proposal } from "../types/index.js";
import { slugify } from "./utils.js";

interface GitHubConfig {
  owner: string;
  repo: string;
  enabled: boolean;
  /** Opt-in: track proposal modifications as GitHub issues. */
  issues?: boolean;
  defaultBranch?: string;
}

let config: GitHubConfig | null = null;

export function configureGitHub(cfg: Partial<GitHubConfig>): void {
  config = { ...config, ...cfg } as GitHubConfig;
}

export function getGitHubConfig(): GitHubConfig | null {
  return config;
}

export function isGitHubEnabled(): boolean {
  return config?.enabled === true && !!config.owner && !!config.repo;
}

/** Whether proposal modifications should be mirrored to GitHub issues. */
export function isIssueSyncEnabled(): boolean {
  return isGitHubEnabled() && config?.issues === true;
}

const GH_TIMEOUT_MS = 30_000;

function runGh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error(`gh ${args.join(" ")} timed out after ${GH_TIMEOUT_MS}ms`));
      }
    }, GH_TIMEOUT_MS);
    stdoutStream?.on("data", (chunk) => {
      stdout += chunk;
    });
    stderrStream?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `gh exited with code ${code}`));
    });
    if (input !== undefined) {
      stdinStream?.on("error", () => {});
      stdinStream?.write(input);
      stdinStream?.end();
    }
  });
}

/** Call `gh api <route>` and parse the JSON response (null for empty bodies). */
async function ghApi<T>(route: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const args = ["api", route];
  if (options?.method) args.push("-X", options.method);
  if (options?.body !== undefined) args.push("--input", "-");
  let stdout: string;
  try {
    stdout = await runGh(args, options?.body === undefined ? undefined : JSON.stringify(options.body));
  } catch (error) {
    throw new Error(
      `gh api ${route} failed: ${error instanceof Error ? error.message : String(error)}. ` +
        "Ensure the GitHub CLI is installed and authenticated (`gh auth login`).",
    );
  }
  const text = stdout.trim();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON from gh api ${route}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function ghBranchNameFor(proposal: Proposal): string {
  return `dao/${proposal.id}-${slugify(proposal.title)}`;
}

export async function ghCreateBranch(
  branchName: string,
  baseBranch?: string,
): Promise<{ ref: string; sha: string } | null> {
  if (!isGitHubEnabled()) return null;

  const base = baseBranch || config?.defaultBranch || "main";

  // Get base branch SHA
  const refData = await ghApi<{ object?: { sha: string } }>(
    `repos/${config?.owner}/${config?.repo}/git/ref/heads/${base}`,
  );
  const sha = refData?.object?.sha;
  if (!sha) return null;

  // Create branch. A 422 "already exists" is tolerated so re-runs are
  // idempotent (matching the previous REST integration behaviour).
  try {
    await ghApi<unknown>(`repos/${config?.owner}/${config?.repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branchName}`, sha },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists")) throw error;
  }

  return { ref: `refs/heads/${branchName}`, sha };
}

export async function ghCreatePullRequest(
  proposal: Proposal,
  options: {
    headBranch: string;
    baseBranch?: string;
    draft?: boolean;
    linkedIssue?: number;
  },
): Promise<{ number: number; url: string } | null> {
  if (!isGitHubEnabled()) return null;

  const data = await ghApi<{ number: number; html_url: string }>(`repos/${config?.owner}/${config?.repo}/pulls`, {
    method: "POST",
    body: {
      title: proposal.title,
      body: buildPRBody(proposal, options.linkedIssue),
      head: options.headBranch,
      base: options.baseBranch || config?.defaultBranch || "main",
      draft: options.draft ?? false,
    },
  });
  if (!data) return null;
  return { number: data.number, url: data.html_url };
}

export async function ghCreateIssue(
  title: string,
  body: string,
  labels?: string[],
): Promise<{ number: number; url: string } | null> {
  if (!isIssueSyncEnabled()) return null;

  try {
    const data = await ghApi<{ number: number; html_url: string }>(`repos/${config?.owner}/${config?.repo}/issues`, {
      method: "POST",
      body: { title, body, labels: labels ?? ["dao-proposal"] },
    });
    if (!data) return null;
    return { number: data.number, url: data.html_url };
  } catch (error) {
    logger.warn("ghCreateIssue failed: %s", error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function ghUpdateIssue(
  issueNumber: number,
  updates: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
): Promise<boolean> {
  if (!isIssueSyncEnabled()) return false;

  try {
    await ghApi<unknown>(`repos/${config?.owner}/${config?.repo}/issues/${issueNumber}`, {
      method: "PATCH",
      body: updates,
    });
    return true;
  } catch (error) {
    logger.warn("ghUpdateIssue failed: %s", error instanceof Error ? error.message : String(error));
    return false;
  }
}

function buildPRBody(proposal: Proposal, linkedIssue?: number): string {
  let body = `## Proposal #${proposal.id}: ${proposal.title}\n\n**Type:** ${proposal.type}\n**Status:** ${proposal.status}\n\n### Description\n${proposal.description}\n`;

  if (proposal.problemStatement) {
    body += `\n### Problem Statement\n${proposal.problemStatement}\n`;
  }

  if (Array.isArray(proposal.acceptanceCriteria) && proposal.acceptanceCriteria.length > 0) {
    body += `\n### Acceptance Criteria\n${proposal.acceptanceCriteria.map((ac) => `- ${typeof ac === "string" ? ac : ac.id}: ${typeof ac === "string" ? ac : ac.then}`).join("\n")}\n`;
  }

  if (proposal.synthesis) {
    body += `\n### Deliberation Summary\n${proposal.synthesis.slice(0, 500)}${proposal.synthesis.length > 500 ? "..." : ""}\n`;
  }

  if (linkedIssue) {
    body += `\nCloses #${linkedIssue}\n`;
  }

  return body;
}

// ── Proposal Sync ────────────────────────────────────────────

export async function ghSyncProposal(proposal: Proposal, issueNumber?: number): Promise<number | null> {
  if (!isIssueSyncEnabled()) return null;

  const body = `## DAO Proposal #${proposal.id}\n\n**Type:** ${proposal.type}\n**Risk Zone:** ${proposal.riskZone ?? "unknown"}\n**Status:** ${proposal.status}\n\n${proposal.description}\n\n${proposal.problemStatement ? `### Problem Statement\n${proposal.problemStatement}\n` : ""}`;

  if (issueNumber) {
    await ghUpdateIssue(issueNumber, { body, title: `[DAO] #${proposal.id}: ${proposal.title}` });
    return issueNumber;
  }

  const issue = await ghCreateIssue(`[DAO] #${proposal.id}: ${proposal.title}`, body);
  return issue?.number ?? null;
}
