// ============================================================
// Swarm DAO Core — GitLab Integration
// ============================================================

import type { Proposal } from "../types/index.js";
import { slugify } from "./utils.js";

interface GitLabConfig {
  token: string;
  url: string;
  projectId: string;
  enabled: boolean;
  defaultBranch?: string;
}

let config: GitLabConfig | null = null;

export function configureGitLab(cfg: Partial<GitLabConfig>): void {
  config = { ...config, ...cfg } as GitLabConfig;
}

export function getGitLabConfig(): GitLabConfig | null {
  return config;
}

function getAuthToken(): string | undefined {
  const token = config?.token;
  if (token && token !== "[REDACTED]") {
    return token;
  }
  return process.env.DAO_GITLAB_TOKEN;
}

export function isGitLabEnabled(): boolean {
  return config?.enabled === true && !!getAuthToken() && !!config.projectId;
}

function getApiBase(): string {
  const url = config?.url || "https://gitlab.com";
  return `${url.replace(/\/$/, "")}/api/v4`;
}

function getAuthHeaders(): Record<string, string> {
  return {
    "PRIVATE-TOKEN": getAuthToken() ?? "",
    "Content-Type": "application/json",
  };
}

export function glBranchNameFor(proposal: Proposal): string {
  return `dao/${proposal.id}-${slugify(proposal.title)}`;
}

export async function glCreateBranch(
  branchName: string,
  baseBranch?: string,
): Promise<{ ref: string; sha: string } | null> {
  if (!isGitLabEnabled()) return null;

  const base = baseBranch || config?.defaultBranch || "main";

  const res = await fetch(
    `${getApiBase()}/projects/${encodeURIComponent(config?.projectId ?? "")}/repository/branches`,
    {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ branch: branchName, ref: base }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to create branch: ${res.status}`);
  }

  const data = (await res.json()) as { name: string; commit: { id: string } };
  return { ref: `refs/heads/${data.name}`, sha: data.commit.id };
}

export async function glCreateMergeRequest(
  proposal: Proposal,
  options: {
    sourceBranch: string;
    targetBranch?: string;
  },
): Promise<{ iid: number; url: string } | null> {
  if (!isGitLabEnabled()) return null;

  const body = buildMRBody(proposal);

  const res = await fetch(`${getApiBase()}/projects/${encodeURIComponent(config?.projectId ?? "")}/merge_requests`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      source_branch: options.sourceBranch,
      target_branch: options.targetBranch || config?.defaultBranch || "main",
      title: proposal.title,
      description: body,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create MR: ${res.status}`);
  }

  const data = (await res.json()) as { iid: number; web_url: string };
  return { iid: data.iid, url: data.web_url };
}

export async function glCreateIssue(
  title: string,
  body: string,
  labels?: string[],
): Promise<{ iid: number; url: string } | null> {
  if (!isGitLabEnabled()) return null;

  const res = await fetch(`${getApiBase()}/projects/${encodeURIComponent(config?.projectId ?? "")}/issues`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ title, description: body, labels: labels?.join(",") }),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as { iid: number; web_url: string };
  return { iid: data.iid, url: data.web_url };
}

function buildMRBody(proposal: Proposal): string {
  let body = `## Proposal #${proposal.id}: ${proposal.title}\n\n**Type:** ${proposal.type}\n**Status:** ${proposal.status}\n\n### Description\n${proposal.description}\n`;
  if (proposal.problemStatement) {
    body += `\n### Problem Statement\n${proposal.problemStatement}\n`;
  }
  if (proposal.synthesis) {
    body += `\n### Deliberation Summary\n${proposal.synthesis.slice(0, 500)}...\n`;
  }
  return body;
}
