// ============================================================
// Swarm DAO Core — GitHub Integration
// ============================================================

import type { Proposal } from "../types/index.js";
import { HttpRequestError, requestJson } from "./http.js";
import { slugify } from "./utils.js";

interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  enabled: boolean;
  apiBase?: string;
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
  return config?.enabled === true && !!config.token && !!config.owner && !!config.repo;
}

function getApiBase(): string {
  return config?.apiBase || "https://api.github.com";
}

function getAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config?.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
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
  let refData: { object?: { sha: string } } | null;
  try {
    ({ data: refData } = await requestJson<{ object?: { sha: string } }>(
      `${getApiBase()}/repos/${config?.owner}/${config?.repo}/git/ref/heads/${base}`,
      {
        headers: getAuthHeaders(),
      },
    ));
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw new Error(`Failed to get ref for ${base}: ${error.status}`);
    }
    throw error;
  }
  const sha = refData?.object?.sha;
  if (!sha) return null;

  // Create branch
  await requestJson<unknown>(`${getApiBase()}/repos/${config?.owner}/${config?.repo}/git/refs`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
    allowStatuses: [422],
  });

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

  const body = buildPRBody(proposal, options.linkedIssue);

  let data: { number: number; html_url: string } | null;
  try {
    ({ data } = await requestJson<{ number: number; html_url: string }>(
      `${getApiBase()}/repos/${config?.owner}/${config?.repo}/pulls`,
      {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: proposal.title,
          body,
          head: options.headBranch,
          base: options.baseBranch || config?.defaultBranch || "main",
          draft: options.draft ?? false,
        }),
      },
    ));
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw new Error(`Failed to create PR: ${error.status}`);
    }
    throw error;
  }
  if (!data) return null;
  return { number: data.number, url: data.html_url };
}

export async function ghCreateIssue(
  title: string,
  body: string,
  labels?: string[],
): Promise<{ number: number; url: string } | null> {
  if (!isGitHubEnabled()) return null;

  try {
    const { data } = await requestJson<{ number: number; html_url: string }>(
      `${getApiBase()}/repos/${config?.owner}/${config?.repo}/issues`,
      {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, labels: labels ?? ["dao-proposal"] }),
      },
    );
    if (!data) return null;
    return { number: data.number, url: data.html_url };
  } catch {
    return null;
  }
}

export async function ghUpdateIssue(
  issueNumber: number,
  updates: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
): Promise<boolean> {
  if (!isGitHubEnabled()) return false;

  try {
    await requestJson<unknown>(`${getApiBase()}/repos/${config?.owner}/${config?.repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    return true;
  } catch {
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
  if (!isGitHubEnabled()) return null;

  const body = `## DAO Proposal #${proposal.id}\n\n**Type:** ${proposal.type}\n**Risk Zone:** ${proposal.riskZone ?? "unknown"}\n**Status:** ${proposal.status}\n\n${proposal.description}\n\n${proposal.problemStatement ? `### Problem Statement\n${proposal.problemStatement}\n` : ""}`;

  if (issueNumber) {
    await ghUpdateIssue(issueNumber, { body, title: `[DAO] #${proposal.id}: ${proposal.title}` });
    return issueNumber;
  }

  const issue = await ghCreateIssue(`[DAO] #${proposal.id}: ${proposal.title}`, body);
  return issue?.number ?? null;
}
