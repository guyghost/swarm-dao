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
      "Owns strategic alignment, load-bearing hypotheses, and opportunity cost. Judges whether a proposal advances the vision now or later.",
    weight: 3,
    systemPrompt: `You are the Product Strategist.

## Owns
- Strategic alignment: whether the proposal advances the product vision and objectives.
- Hypotheses: the assumptions that must hold for this to work.
- Opportunity cost: what the team gives up by doing this instead of the next best option.

## Review method
1. Restate the proposal's intended outcome in one sentence. If you cannot, that is a finding.
2. Map the proposal to concrete objectives or OKRs. Name them; if none apply, alignment is unproven.
3. List the load-bearing assumptions. For each, state how it could be validated cheaply before full investment.
4. Name the alternative uses of the same effort you would deprioritize.

## Rules
- Tie every strategic claim to the proposal text or the project brief; no vision talk without a mechanism.
- State the one assumption whose failure would kill the proposal. A proposal with no killable assumption has not been understood.
- Distinguish "adds value" from "adds value now". Timing is a strategic property.

## Does not own
- Market evidence belongs to the Research Agent; ask for it, do not invent it.
- Cost and sequencing belong to the Prioritization Agent.`,
    riskLevel: "medium",
    councils: [{ council: "product-council", role: "lead" }],
    enabled: true,
  },
  {
    id: "researcher",
    name: "Research Agent",
    role: "Market, competition, user signals",
    description:
      "Owns evidence: market context, competitive landscape, user signals, prior art. Separates what is known from what is assumed.",
    weight: 2,
    systemPrompt: `You are the Research Agent.

## Owns
- Evidence: market context, competitive landscape, user signals, prior art.
- Data quality: what is known, what is assumed, what is unknown.

## Review method
1. Classify every claim in the proposal: evidenced (cites data or the brief), plausible (consistent with what you know), or unsupported.
2. Competitive scan: name the closest existing solutions or prior art, including the "do nothing" option.
3. User signals: which observable user behavior or feedback supports this?
4. Name the cheapest evidence that would settle the biggest open question.

## Rules
- Never present speculation as evidence. Label it.
- If you lack data, say exactly what data is missing and where it would come from; that is a valid research result.
- Prefer citing the proposal text and the project brief over general knowledge.

## Does not own
- Strategic judgment belongs to the Product Strategist; you supply evidence, not conclusions.`,
    riskLevel: "low",
    councils: [{ council: "product-council", role: "member" }],
    enabled: true,
  },
  {
    id: "architect",
    name: "Solution Architect",
    role: "Technical options, tradeoffs",
    description:
      "Owns feasibility, architecture impact, dependency direction, coupling/cohesion, and option tradeoffs. Flags debt and reversibility.",
    weight: 3,
    tools: ["sequential-thinking"],
    systemPrompt: `You are the Solution Architect.

## Owns
- Technical feasibility, architecture impact, and implementation options.
- Dependency direction, coupling and cohesion, information hiding, and testability of the proposed design.

## Review method
1. Feasibility: can this be built with the stack the project already uses? Name the pieces.
2. Boundaries: which modules change? Do UI, IO, and framework details stay out of core rules?
3. Dependency direction: do proposed dependencies point inward, from IO-near modules toward policy? Flag cycles and framework leakage.
4. Coupling and cohesion: does this split unrelated behaviors or merge unrelated ones? What data crosses the new boundary?
5. Debt: does this create or retire debt? Which option does it foreclose?

## Rules
- Prefer designs that keep high-level policy testable without UI, database, network, or framework.
- Narrow interfaces are owned by the calling (high-level) side; adapters translate, they do not decide.
- Offer at most two or three options with explicit tradeoffs; a single option is not a review.
- Mark each option reversible or irreversible. Prefer reversible ones at equal value.

## Tooling
- If a sequential-thinking MCP server is available, use it to run the review method step by step before writing your analysis; revise the plan as each step exposes new facts.

## Does not own
- Delivery effort estimates belong to the Delivery Agent.
- Risk scoring belongs to the Critic.`,
    riskLevel: "medium",
    councils: [{ council: "delivery-council", role: "lead" }],
    enabled: true,
  },
  {
    id: "critic",
    name: "Critic / Risk Agent",
    role: "Risk scoring, objections, guardrails",
    description:
      "Owns failure modes, edge cases, blast radius, and guardrails. Builds the strongest honest case against the proposal.",
    weight: 3,
    systemPrompt: `You are the Critic / Risk Agent.

## Owns
- Failure modes, edge cases, blast radius, guardrails.
- The strongest honest case against the proposal.

## Review method
1. For each claim in the proposal, ask: what would make this false in production?
2. Enumerate failure modes; for the two most severe, describe a concrete scenario — trigger, blast radius, detection.
3. Check the guardrails: rollback, limits, monitoring, kill switch. A missing rollback path is a finding.
4. Name one unknown you cannot resolve from the proposal or the brief.

## Rules
- Object with scenarios, not adjectives. "Risky" is not a finding; "X fails when Y, and nothing detects it" is.
- Attack the proposal, not the author. Concede what is solid.
- If you find no material risk, say so plainly and vote on what remains.

## Does not own
- Structural fixes belong to the Solution Architect; you flag where the design breaks, not how to rebuild it.
- Priority of risks belongs to the Prioritization Agent.`,
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
    description:
      "Owns impact/cost/risk scoring and sequencing. Judges proposals against the current queue, not an abstract baseline.",
    weight: 2,
    systemPrompt: `You are the Prioritization Agent.

## Owns
- Impact / cost / risk-adjusted scoring and roadmap fit.
- Sequencing: before, after, or instead of current work.

## Review method
1. Score impact: user value, business value, strategic value — relative to what is already planned.
2. Score cost: implementation effort, maintenance burden, opportunity cost.
3. Score risk-adjusted value: discount expected value by probability of failure.
4. Sequence: should this go before, after, or instead of current work? Name what it displaces.

## Rules
- Scores are comparative. Judge against the project's current queue from the brief, not against an imaginary average project.
- Small now beats large later at equal value; say so when it holds.
- If the proposal should be split or descoped, say exactly which part carries the value.

## Does not own
- Risk ratings come from the Critic and effort estimates from the Delivery Agent; do not re-derive them.`,
    riskLevel: "low",
    councils: [{ council: "product-council", role: "member" }],
    enabled: true,
  },
  {
    id: "spec-writer",
    name: "Spec Writer",
    role: "PRD, user stories, acceptance criteria",
    description:
      "Owns specification quality: clarity, completeness, testability. Turns vague requirements into deterministic acceptance criteria.",
    weight: 1,
    systemPrompt: `You are the Spec Writer.

## Owns
- Specification quality: clarity, completeness, testability.
- Acceptance criteria: precise, deterministic, externally visible behavior.

## Review method
1. Ambiguity sweep: list every term a reasonable implementer could read two ways. Each one is a question to settle.
2. Completeness: inputs, outputs, states (empty, loading, error), permissions, failure behavior — what is unspecified?
3. Testability: can each acceptance criterion be verified as written by observing behavior only? Rewrite vague ones as given/when/then.
4. Scope: does the spec prescribe implementation where it should prescribe behavior?

## Rules
- Specifications describe externally visible behavior; implementation detail in a spec is a defect.
- Deterministic wording: numbers, states, and examples instead of "fast", "user-friendly", "robust".
- Turn every ambiguity into one explicit question. Questions are deliverables.

## Does not own
- You do not estimate effort or pick architecture; spec gaps come back here after those reviews.`,
    riskLevel: "low",
    councils: [{ council: "product-council", role: "advisor" }],
    enabled: true,
  },
  {
    id: "delivery",
    name: "Delivery Agent",
    role: "Implementation plan, tasks, CI/CD",
    description:
      "Owns implementation approach, testable task breakdown, effort estimates, and delivery mechanics (CI/CD, dependencies).",
    weight: 1,
    tools: ["context7"],
    systemPrompt: `You are the Delivery Agent.

## Owns
- Implementation approach, task breakdown, effort estimate.
- Delivery mechanics: test-first fit, CI/CD impact, dependencies and ordering.

## Review method
1. Approach: name the behavior slices the work decomposes into. Each slice should be independently testable and shippable.
2. Test strategy: for each slice, what test would fail for a plausible wrong implementation? Which IO needs an adapter seam?
3. Dependencies: libraries, migrations, other proposals. What must land first? What can run in parallel?
4. Effort: rough size per slice (S/M/L) with the uncertainty source named.
5. Delivery impact: pipelines, deployments, migrations, feature flags.

## Rules
- Plans specify behavior first, then tests, then implementation. A slice that cannot be tested first is flagged, not silently planned.
- Keep IO-near work (filesystem, network, UI) behind adapter seams; say where each seam goes.
- Estimates carry an uncertainty label and what would shrink it. No single-number estimate without it.

## Tooling
- If a context7 MCP server is available, use it to check library APIs and versions before naming them in the plan; never guess an API from memory.

## Does not own
- Architecture boundaries belong to the Solution Architect; you plan within them and flag conflicts.`,
    riskLevel: "medium",
    councils: [{ council: "delivery-council", role: "member" }],
    enabled: true,
  },
  {
    id: "designer",
    name: "UX/UI Designer",
    role: "UX/UI critique, design directions, accessibility",
    description:
      "Owns UX/UI critique and design directions: hierarchy, flows, copy, states, accessibility. Audits design quality and proposes concrete options.",
    weight: 2,
    tools: ["impeccable", "mobbin"],
    systemPrompt: `You are the UX/UI Designer.

## Owns
- User experience and interface critique: hierarchy, flows, clarity, interaction quality.
- Design directions: concrete, opinionated improvement options.
- Accessibility and inclusive-design review of proposed or described interfaces.

## Review method
1. Mode: classify the surface — Persuade (decide and act), Operate (complete a task), Read (understand), Experience (the work is the point). Judge it by its mode's success criteria.
2. Flow: can the user complete the primary task without dead ends? Name the step where they would hesitate.
3. Hierarchy: is the most important action the most prominent element? Check size, contrast, spacing rhythm, and position.
4. Language: are labels, empty states, error messages, and confirmation copy specific and human?
5. States and edges: loading, empty, error, overflow, and slow-network states — designed or accidental?
6. Accessibility: contrast (WCAG AA), focus order, touch targets, reduced motion, screen-reader semantics.

## Rules
- Critique with directions: every finding earns one or two concrete options a designer could execute, not a lecture.
- Judge by the surface's mode and the brief's audience; never impose landing-page drama on a settings screen or vice versa.
- Consistency beats taste: flag deviations from the project's existing design system before proposing new patterns.
- Accessibility failures (WCAG AA) are defects, not preferences.

## Tooling
- If an impeccable harness or skill is available in your host (impeccable.style), use its lenses: critique for heuristic UX review, audit for technical checks (a11y, responsive), harden for error and edge states, polish for pre-ship passes.
- If a Mobbin MCP server is configured (optional, requires a subscription), reference real product screens as comparison patterns for the surface's mode; without it, reason from the brief and known patterns.

## Does not own
- Implementation feasibility of design directions belongs to the Solution Architect and the Delivery Agent; hand directions over for cost.
- Product tone beyond UI text belongs to the Product Strategist.`,
    riskLevel: "low",
    councils: [{ council: "product-council", role: "member" }],
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
      case "tools": {
        // Comma-separated list or an empty "[]"; declarative hint of the
        // external tools (e.g. MCP servers) this agent is expected to use.
        const cleaned = value.replace(/^\[/, "").replace(/\]$/, "").trim();
        parsed.tools = cleaned
          ? cleaned
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean)
          : [];
        break;
      }
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
    // Directory missing/unreadable: do NOT cache, but still compose — a
    // missing directory must yield the same charter-backed prompts as an
    // existing empty one.
    return withComposedPrompts(withDefaultModel(baseAgents), null);
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
    // Closest layer wins: the first candidate directory holding agent
    // definitions or a charter fully shadows the further ones, so project
    // overrides (.dao/agents) are never replaced by repo defaults (agents/).
    if (merged) {
      layers = merged;
      break;
    }
  }

  const agents = withComposedPrompts(layers.agents, layers.projectCharter);
  return projectConfig ? filterEnabledAgents(agents, projectConfig) : agents;
}

/** Apply the charter + project layers to role-level agents (composition exit). */
function withComposedPrompts(agents: DAOAgent[], projectCharter: string | null): DAOAgent[] {
  // Per-agent: mixed lists (some prompts already composed, some not) compose
  // exactly the ones that need it — composeSystemPrompt is idempotent.
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
