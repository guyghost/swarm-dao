// ============================================================
// Swarm DAO Core — Agent Registry & Default Agents
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config.js";
import { filterEnabledAgents } from "../config.js";
import type { DAOAgent } from "../types/index.js";
import { AGENT_CHARTER, composeSystemPrompt } from "./charter.js";

export const DEFAULT_AGENT_MODEL = "z.ai/GLM-5.1";

export const DEFAULT_AGENTS: DAOAgent[] = [
  {
    id: "strategist",
    name: "Product Strategist",
    role: "Vision, objectives, hypotheses",
    description:
      "Evaluates proposals against product vision and strategic objectives. Identifies misalignment risks and opportunity costs.",
    weight: 3,
    systemPrompt: `You are the Product Strategist in a DAO governance system.

Your mission: evaluate proposals from a product strategy perspective.

For each proposal, analyze:
1. Strategic alignment — does this fit the product vision?
2. Objectives — which OKRs or goals does this advance?
3. Hypotheses — what assumptions underlie this proposal?
4. Opportunity cost — what are we NOT doing if we do this?`,
    riskLevel: "medium",
    councils: [{ council: "product-council", role: "lead" }],
    enabled: true,
  },
  {
    id: "researcher",
    name: "Research Agent",
    role: "Market, competition, user signals",
    description:
      "Gathers and analyzes market data, competitive landscape, and user feedback to inform proposal evaluation.",
    weight: 2,
    systemPrompt: `You are the Research Agent in a DAO governance system.

Your mission: provide evidence-based research on proposals.

For each proposal, research:
1. Market context — trends, market size, growth
2. Competition — what are competitors doing?
3. User signals — feedback, requests, pain points
4. Data availability — do we have evidence to support this?`,
    riskLevel: "low",
    councils: [{ council: "product-council", role: "member" }],
    enabled: true,
  },
  {
    id: "architect",
    name: "Solution Architect",
    role: "Technical options, tradeoffs",
    description:
      "Evaluates technical feasibility, architecture impact, and implementation options. Identifies technical debt and scalability concerns.",
    weight: 3,
    systemPrompt: `You are the Solution Architect in a DAO governance system.

Your mission: evaluate proposals from a technical architecture perspective.

For each proposal, analyze:
1. Technical feasibility — can we build this?
2. Architecture impact — how does this affect system design?
3. Tradeoffs — what are the key technical tradeoffs?
4. Technical debt — will this create or reduce debt?
5. Scalability — will this scale with our growth?`,
    riskLevel: "medium",
    councils: [{ council: "delivery-council", role: "lead" }],
    enabled: true,
  },
  {
    id: "critic",
    name: "Critic / Risk Agent",
    role: "Risk scoring, objections, guardrails",
    description:
      "Identifies risks, raises objections, and ensures guardrails are in place. The devil's advocate of the swarm.",
    weight: 3,
    systemPrompt: `You are the Critic / Risk Agent in a DAO governance system.

Your mission: identify risks and raise critical objections.

For each proposal, scrutinize:
1. Risks — what could go wrong?
2. Edge cases — what scenarios aren't covered?
3. Guardrails — are sufficient protections in place?
4. Downside — what's the worst-case outcome?
5. Unknown unknowns — what haven't we considered?`,
    riskLevel: "high",
    councils: [
      { council: "security-council", role: "lead" },
      { council: "product-council", role: "member" },
    ],
    enabled: true,
  },
  {
    id: "prioritizer",
    name: "Prioritization Agent",
    role: "Impact/cost/risk scoring, roadmap fit",
    description: "Scores proposals on impact, cost, and risk dimensions. Evaluates roadmap fit and sequencing.",
    weight: 2,
    systemPrompt: `You are the Prioritization Agent in a DAO governance system.

Your mission: evaluate proposals through an impact/cost/risk lens.

For each proposal, score:
1. Impact — user value, business value, strategic value
2. Cost — implementation effort, maintenance burden
3. Risk — probability of failure, downside exposure
4. Roadmap fit — does this belong in our current sequence?
5. Urgency — how time-sensitive is this?`,
    riskLevel: "low",
    councils: [{ council: "product-council", role: "member" }],
    enabled: true,
  },
  {
    id: "spec-writer",
    name: "Spec Writer",
    role: "PRD, user stories, acceptance criteria",
    description:
      "Analyzes proposals for specification completeness. Evaluates whether requirements are clear and testable.",
    weight: 1,
    systemPrompt: `You are the Spec Writer in a DAO governance system.

Your mission: evaluate proposals for specification quality.

For each proposal, assess:
1. Clarity — are requirements unambiguous?
2. Completeness — what's missing from the spec?
3. Testability — can we write acceptance criteria?
4. User stories — can this be broken into stories?
5. Edge cases — are boundary conditions defined?`,
    riskLevel: "low",
    councils: [{ council: "product-council", role: "advisor" }],
    enabled: true,
  },
  {
    id: "delivery",
    name: "Delivery Agent",
    role: "Implementation plan, tasks, CI/CD",
    description:
      "Evaluates delivery feasibility, estimates effort, and plans implementation. Considers CI/CD and deployment impact.",
    weight: 1,
    systemPrompt: `You are the Delivery Agent in a DAO governance system.

Your mission: evaluate proposals from a delivery and execution perspective.

For each proposal, plan:
1. Implementation approach — how would we build this?
2. Task breakdown — what are the key tasks?
3. Effort estimate — rough timeline and resources
4. CI/CD impact — how does this affect pipelines?
5. Dependencies — what must happen first?`,
    riskLevel: "medium",
    councils: [{ council: "delivery-council", role: "member" }],
    enabled: true,
  },
];

function parseAgentFrontmatter(content: string): Partial<DAOAgent> & { id?: string; body?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return { body: content.trim() || undefined };

  const parsed: Partial<DAOAgent> & { id?: string; body?: string } = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (!key || !rawValue) continue;
    const value = rawValue.trim();

    switch (key) {
      case "id":
        parsed.id = value;
        break;
      case "name":
        parsed.name = value;
        break;
      case "role":
        parsed.role = value;
        break;
      case "model":
        parsed.model = value;
        break;
      case "weight":
        parsed.weight = Number(value);
        break;
      default:
        break;
    }
  }
  // The markdown body is the per-agent project layer (## Project
  // Instructions); frontmatter fields still override agent metadata.
  const body = content.slice(match[0].length).trim();
  if (body) parsed.body = body;
  return parsed;
}

// ── Agent Definition Cache ────────────────────────────────────
// Module-level cache so dao-*.md files are not re-read from disk on every
// dao_deliberate / dao_roundtable. Keyed by the absolute agentsDir path; each
// entry is validated by a signature derived from the directory listing (the
// dao-*.md entry names plus their mtimeMs and size). On a signature hit the
// cached merged result is returned WITHOUT re-reading any files.
//
// Correctness: cache entries include a stable fingerprint of `baseAgents`, so
// callers with different base arrays for the same directory/signature do not
// cross-hit each other's cached merge result. Callers of the returned agents
// only READ agent fields (never mutate the array or its elements), so the
// cached array is returned directly. Do not mutate the returned array.
interface AgentDefinitionCacheEntry {
  signature: string;
  result: DAOAgent[];
}

const agentDefinitionCache = new Map<string, AgentDefinitionCacheEntry>();

function baseAgentsFingerprint(baseAgents: DAOAgent[]): string {
  return JSON.stringify(baseAgents.map((agent) => ({ ...agent, model: agent.model ?? DEFAULT_AGENT_MODEL })));
}

/** Clear the module-level agent definition cache. Intended for use in tests. */
export function __resetAgentDefinitionCache(): void {
  agentDefinitionCache.clear();
}

function withDefaultModel(agents: DAOAgent[]): DAOAgent[] {
  return agents.map((agent) => ({ ...agent, model: agent.model ?? DEFAULT_AGENT_MODEL }));
}

/** Raw (uncomposed) merge result: role-level agents plus the project charter. */
interface MarkdownLayers {
  agents: DAOAgent[];
  projectCharter: string | null;
}

async function readAndMergeMarkdownAgents(
  absDir: string,
  daoEntries: string[],
  baseAgents: DAOAgent[],
  base: MarkdownLayers,
): Promise<MarkdownLayers> {
  const markdownAgents = new Map<string, Partial<DAOAgent> & { body?: string }>();
  const parsedEntries = await Promise.all(
    daoEntries.map(async (entry) => {
      const content = await fs.readFile(path.join(absDir, entry), "utf-8");
      return parseAgentFrontmatter(content);
    }),
  );
  for (const frontmatter of parsedEntries) {
    if (frontmatter.id) {
      markdownAgents.set(frontmatter.id, frontmatter);
    }
  }

  // The per-project charter layer applies to every agent (swarm-forge
  // local-* convention: layers add to the shared law, never replace it).
  // The closest directory wins: .dao/agents beats the repo's agents/.
  let projectCharter = base.projectCharter;
  if (projectCharter === null) {
    try {
      const charter = await fs.readFile(path.join(absDir, "charter.md"), "utf-8");
      if (charter.trim()) projectCharter = charter.trim();
    } catch {
      // No project charter here — keep looking in the remaining dirs.
    }
  }

  const agents = baseAgents.map((agent) => {
    const override = markdownAgents.get(agent.id);
    if (!override) return agent;
    // The markdown body is the agent's role definition — it REPLACES the
    // default role prompt (consistent with the frontmatter, which already
    // overrides name/role/model/weight). The shared charter is never
    // replaceable: composition always prepends it.
    const { body: _body, ...fields } = override;
    return {
      ...agent,
      ...fields,
      ...(override.body ? { systemPrompt: override.body } : {}),
      model: override.model ?? agent.model ?? DEFAULT_AGENT_MODEL,
    };
  });

  return { agents, projectCharter };
}

export async function loadAgentDefinitionsFromMarkdown(
  agentsDir: string,
  baseAgents: DAOAgent[] = DEFAULT_AGENTS,
): Promise<DAOAgent[]> {
  const absDir = path.resolve(agentsDir);
  const cacheKey = `${absDir}:${baseAgentsFingerprint(baseAgents)}`;

  let entries: string[];
  try {
    entries = await fs.readdir(absDir);
  } catch {
    // Directory missing/unreadable: behave exactly as before and do NOT cache.
    return withDefaultModel(baseAgents);
  }

  const daoEntries = entries.filter((entry) => entry.startsWith("dao-") && entry.endsWith(".md"));

  // Build a signature over the dao-*.md entries (and charter.md, which is
  // also a cached layer) and their stat metadata so the cache invalidates
  // whenever a file is added, removed, or modified.
  let signature: string;
  try {
    const signatureEntries = [...daoEntries];
    if (entries.includes("charter.md")) signatureEntries.push("charter.md");
    const parts = await Promise.all(
      signatureEntries.map(async (entry) => {
        const fileStat = await fs.stat(path.join(absDir, entry));
        return `${entry}:${fileStat.mtimeMs}:${fileStat.size}`;
      }),
    );
    signature = parts.sort().join("|");
  } catch {
    // Could not stat a dao-*.md entry (e.g. raced deletion). Do not cache.
    return withDefaultModel(baseAgents);
  }

  const cached = agentDefinitionCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    // Cache hit: return the merged result without re-reading files.
    return cached.result;
  }

  const layers = await readAndMergeMarkdownAgents(absDir, daoEntries, withDefaultModel(baseAgents), {
    agents: withDefaultModel(baseAgents),
    projectCharter: null,
  });
  // Composition happens exactly once, at the exit.
  const result = withComposedPrompts(layers.agents, layers.projectCharter);
  agentDefinitionCache.set(cacheKey, { signature, result });
  return result;
}

export async function loadAgentDefinitions(daoRoot: string, projectConfig?: ProjectConfig): Promise<DAOAgent[]> {
  const candidateDirs = [
    path.join(daoRoot, "agents"),
    path.join(daoRoot, "..", "agents"),
    path.join(daoRoot, "..", "..", "agents"),
  ];

  // Layer collection over the candidate dirs, closest first. Composition
  // happens exactly once, after collection, so the shared charter is never
  // duplicated across the chain.
  let layers: MarkdownLayers = {
    agents: withDefaultModel(DEFAULT_AGENTS),
    projectCharter: null,
  };
  for (const agentsDir of candidateDirs) {
    const merged = await readMarkdownLayers(agentsDir, layers);
    if (merged) layers = merged;
  }

  const agents = withComposedPrompts(layers.agents, layers.projectCharter);
  return projectConfig ? filterEnabledAgents(agents, projectConfig) : agents;
}

/** Apply the charter + project layers to role-level agents (composition exit). */
function withComposedPrompts(agents: DAOAgent[], projectCharter: string | null): DAOAgent[] {
  // Guard: prompts that are already composed (e.g. callers passing agents
  // obtained from initializeAgents) must not be re-composed.
  if (agents.some((agent) => agent.systemPrompt.startsWith(AGENT_CHARTER))) return agents;
  return agents.map((agent) => ({
    ...agent,
    systemPrompt: composeSystemPrompt(agent.systemPrompt, { projectCharter }),
  }));
}

/** Read and merge one directory's markdown layers; null when it has none. */
async function readMarkdownLayers(agentsDir: string, base: MarkdownLayers): Promise<MarkdownLayers | null> {
  const absDir = path.resolve(agentsDir);
  let entries: string[];
  try {
    entries = await fs.readdir(absDir);
  } catch {
    return null;
  }
  const daoEntries = entries.filter((entry) => entry.startsWith("dao-") && entry.endsWith(".md"));
  const hasCharter = entries.includes("charter.md");
  if (daoEntries.length === 0 && !hasCharter) return null;
  return readAndMergeMarkdownAgents(absDir, daoEntries, base.agents, base);
}

export function initializeAgents(customAgents?: DAOAgent[]): DAOAgent[] {
  if (customAgents && customAgents.length > 0) {
    return customAgents;
  }
  return DEFAULT_AGENTS.map((a) => ({
    ...a,
    systemPrompt: composeSystemPrompt(a.systemPrompt),
    model: a.model ?? DEFAULT_AGENT_MODEL,
  }));
}

export function formatAgentsTable(agents: DAOAgent[]): string {
  let table = "| Agent | Weight | Role |\n|-------|--------|------|\n";
  for (const agent of agents) {
    table += `| ${agent.name} | ${agent.weight} | ${agent.role} |\n`;
  }
  return table;
}

export function formatAgentCard(agent: DAOAgent): string {
  return `## ${agent.name} (\`${agent.id}\`)
- **Role:** ${agent.role}
- **Weight:** ${agent.weight}
- **Risk Level:** ${agent.riskLevel ?? "not set"}
- **Description:** ${agent.description}`;
}

export function getDefaultAgentPrompts(): Record<string, string> {
  return Object.fromEntries(DEFAULT_AGENTS.map((a) => [a.id, composeSystemPrompt(a.systemPrompt)]));
}
