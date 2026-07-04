// ============================================================
// Swarm DAO Core — Agent Registry & Default Agents
// ============================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../config.js";
import { filterEnabledAgents } from "../config.js";
import type { DAOAgent } from "../types/index.js";

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
4. Opportunity cost — what are we NOT doing if we do this?

Output format:
## Analysis
[Your strategic analysis]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10] (lower = less effort)
- securityRisk: [0-10] (lower = less risk)
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`,
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
4. Data availability — do we have evidence to support this?

Output format:
## Analysis
[Your research findings]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10]
- securityRisk: [0-10]
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`,
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
5. Scalability — will this scale with our growth?

Output format:
## Analysis
[Your technical analysis]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10]
- securityRisk: [0-10]
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`,
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
5. Unknown unknowns — what haven't we considered?

Output format:
## Analysis
[Your risk analysis and objections]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10]
- securityRisk: [0-10]
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`,
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
5. Urgency — how time-sensitive is this?

Output format:
## Analysis
[Your prioritization analysis]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10]
- securityRisk: [0-10]
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`,
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
5. Edge cases — are boundary conditions defined?

Output format:
## Analysis
[Your specification analysis]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10]
- securityRisk: [0-10]
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`,
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
5. Dependencies — what must happen first?

Output format:
## Analysis
[Your delivery analysis]

## Vote
for | against | abstain

## Reasoning
[Why you voted this way]

## Composite Score Inputs (0-10)
- userImpact: [0-10]
- businessImpact: [0-10]
- effort: [0-10]
- securityRisk: [0-10]
- confidence: [0-10]

## Risk Score (1-10)
[Overall risk assessment]`,
    riskLevel: "medium",
    councils: [{ council: "delivery-council", role: "member" }],
    enabled: true,
  },
];

function parseAgentFrontmatter(content: string): Partial<DAOAgent> & { id?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};

  const parsed: Partial<DAOAgent> & { id?: string } = {};
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

async function readAndMergeMarkdownAgents(
  absDir: string,
  daoEntries: string[],
  baseAgents: DAOAgent[],
): Promise<DAOAgent[]> {
  const markdownAgents = new Map<string, Partial<DAOAgent>>();
  for (const entry of daoEntries) {
    const content = await fs.readFile(path.join(absDir, entry), "utf-8");
    const frontmatter = parseAgentFrontmatter(content);
    if (frontmatter.id) {
      markdownAgents.set(frontmatter.id, frontmatter);
    }
  }

  return baseAgents.map((agent) => {
    const override = markdownAgents.get(agent.id);
    return {
      ...agent,
      ...(override ?? {}),
      model: override?.model ?? agent.model ?? DEFAULT_AGENT_MODEL,
    };
  });
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

  // Build a signature over the dao-*.md entries and their stat metadata so the
  // cache invalidates whenever an agent file is added, removed, or modified.
  let signature: string;
  try {
    const parts = await Promise.all(
      daoEntries.map(async (entry) => {
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

  const result = await readAndMergeMarkdownAgents(absDir, daoEntries, baseAgents);
  agentDefinitionCache.set(cacheKey, { signature, result });
  return result;
}

export async function loadAgentDefinitions(daoRoot: string, projectConfig?: ProjectConfig): Promise<DAOAgent[]> {
  const candidateDirs = [
    path.join(daoRoot, "agents"),
    path.join(daoRoot, "..", "agents"),
    path.join(daoRoot, "..", "..", "agents"),
  ];

  let agents = initializeAgents();
  for (const agentsDir of candidateDirs) {
    const loaded = await loadAgentDefinitionsFromMarkdown(agentsDir, agents);
    const hasMarkdownOverrides = loaded.some(
      (agent, index) =>
        agent.model !== agents[index]?.model ||
        agent.name !== agents[index]?.name ||
        agent.role !== agents[index]?.role,
    );
    if (hasMarkdownOverrides) {
      agents = loaded;
      break;
    }
  }

  return projectConfig ? filterEnabledAgents(agents, projectConfig) : agents;
}

export function initializeAgents(customAgents?: DAOAgent[]): DAOAgent[] {
  if (customAgents && customAgents.length > 0) {
    return customAgents;
  }
  return DEFAULT_AGENTS.map((a) => ({ ...a, model: a.model ?? DEFAULT_AGENT_MODEL }));
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
  return Object.fromEntries(DEFAULT_AGENTS.map((a) => [a.id, a.systemPrompt]));
}
