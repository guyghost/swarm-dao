// ============================================================
// Swarm DAO Core — Bitbucket Integration
// ============================================================

import type { Proposal } from "../types/index.js";

interface BitbucketConfig {
  token: string;
  username: string;
  workspace: string;
  repo: string;
  enabled: boolean;
  defaultBranch?: string;
}

let config: BitbucketConfig | null = null;

export function configureBitbucket(cfg: Partial<BitbucketConfig>): void {
  config = { ...config, ...cfg } as BitbucketConfig;
}

export function getBitbucketConfig(): BitbucketConfig | null {
  return config;
}

export function isBitbucketEnabled(): boolean {
  return config?.enabled === true && !!config.token && !!config.workspace && !!config.repo;
}

function getAuthHeaders(): Record<string, string> {
  const auth = Buffer.from(`${config?.username}:${config?.token}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function bbBranchNameFor(proposal: Proposal): string {
  return `dao/${proposal.id}-${slugify(proposal.title)}`;
}

export async function bbCreateBranch(
  branchName: string,
  baseBranch?: string,
): Promise<{ ref: string; sha: string } | null> {
  if (!isBitbucketEnabled()) return null;

  const base = baseBranch || config?.defaultBranch || "main";

  // Get base branch commit SHA
  const refRes = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${config?.workspace}/${config?.repo}/refs/branches/${base}`,
    { headers: getAuthHeaders() },
  );
  if (!refRes.ok) {
    throw new Error(`Failed to get ref: ${refRes.status}`);
  }
  const refData = (await refRes.json()) as { target: { hash: string } };
  const sha = refData.target?.hash;
  if (!sha) return null;

  // Create branch (Bitbucket calls refs)
  const createRes = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${config?.workspace}/${config?.repo}/refs/branches`,
    {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ name: branchName, target: { hash: sha } }),
    },
  );

  if (!createRes.ok && createRes.status !== 409) {
    throw new Error(`Failed to create branch: ${createRes.status}`);
  }

  return { ref: `refs/heads/${branchName}`, sha };
}

export async function bbCreatePullRequest(
  proposal: Proposal,
  options: {
    sourceBranch: string;
    targetBranch?: string;
  },
): Promise<{ id: number; url: string } | null> {
  if (!isBitbucketEnabled()) return null;

  const body = buildPRBody(proposal);

  const res = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${config?.workspace}/${config?.repo}/pullrequests`,
    {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({
        title: proposal.title,
        description: body,
        source: { branch: { name: options.sourceBranch } },
        destination: { branch: { name: options.targetBranch || config?.defaultBranch || "main" } },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to create PR: ${res.status}`);
  }

  const data = (await res.json()) as { id: number; links: { html: { href: string } } };
  return { id: data.id, url: data.links.html.href };
}

function buildPRBody(proposal: Proposal): string {
  let body = `**Proposal #${proposal.id}:** ${proposal.title}\n\n**Type:** ${proposal.type}\n**Status:** ${proposal.status}\n\n${proposal.description}\n`;
  if (proposal.problemStatement) {
    body += `\n**Problem Statement:**\n${proposal.problemStatement}\n`;
  }
  return body;
}
