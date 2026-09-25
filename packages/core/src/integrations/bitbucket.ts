// ============================================================
// Swarm DAO Core — Bitbucket Integration
// ============================================================

import type { Proposal } from "../types/index.js";
import { slugify } from "./utils.js";

interface BitbucketConfig {
  token: string;
  username: string;
  workspace: string;
  repo: string;
  enabled: boolean;
  defaultBranch?: string;
}

let config: BitbucketConfig | null = null;

/** Bitbucket workspace/repo slug charset (issue #166 parity): both values are
 *  interpolated into the API route path. Alphanumerics plus `.`, `_`, `-`;
 *  `/`, `\`, control characters and `..` are rejected so a config value can
 *  never re-route the request to another API resource. */
const BITBUCKET_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateBitbucketSlug(kind: "workspace" | "repo", value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return `${kind} must not be empty`;
  if (value.length > 100) return `${kind} is too long (max 100 characters)`;
  if (!BITBUCKET_SLUG.test(value)) {
    return `${kind} '${value}' must match ${BITBUCKET_SLUG.toString()} (no '/', '\\', '..', or control characters)`;
  }
  if (value.includes("..")) return `${kind} must not contain '..'`;
  return null;
}

export function configureBitbucket(cfg: Partial<BitbucketConfig>): void {
  // Validate at the chokepoint: every path (persistence, CLI, env) funnels
  // through here, and these values reach the API route interpolation.
  if (cfg.workspace !== undefined) {
    const error = validateBitbucketSlug("workspace", cfg.workspace);
    if (error) throw new Error(`Invalid Bitbucket configuration: ${error}`);
  }
  if (cfg.repo !== undefined) {
    const error = validateBitbucketSlug("repo", cfg.repo);
    if (error) throw new Error(`Invalid Bitbucket configuration: ${error}`);
  }
  config = { ...config, ...cfg } as BitbucketConfig;
}

export function getBitbucketConfig(): BitbucketConfig | null {
  return config;
}

function getAuthToken(): string | undefined {
  const token = config?.token;
  if (token && token !== "[REDACTED]") {
    return token;
  }
  return process.env.DAO_BITBUCKET_TOKEN;
}

export function isBitbucketEnabled(): boolean {
  return config?.enabled === true && !!getAuthToken() && !!config.workspace && !!config.repo;
}

function getAuthHeaders(): Record<string, string> {
  const auth = Buffer.from(`${config?.username}:${getAuthToken()}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };
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

  // Get base branch commit SHA. Slugs are validated at configuration, but the
  // branch name is a path parameter that legitimately contains '/' (e.g.
  // "feature/foo"): encode it or the request hits the wrong route.
  const refRes = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(config?.workspace ?? "")}/${encodeURIComponent(config?.repo ?? "")}/refs/branches/${encodeURIComponent(base)}`,
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
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(config?.workspace ?? "")}/${encodeURIComponent(config?.repo ?? "")}/refs/branches`,
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
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(config?.workspace ?? "")}/${encodeURIComponent(config?.repo ?? "")}/pullrequests`,
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
