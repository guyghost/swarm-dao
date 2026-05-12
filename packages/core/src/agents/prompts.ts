// ============================================================
// Swarm DAO Core — Agent Prompts (Versioning & A/B Testing)
// ============================================================

import type { DAOAgent } from "../types/index.js";

export interface PromptVariant {
  id: string;
  name: string;
  systemPrompt: string;
  weight: number; // traffic split (0-100)
  metrics: PromptMetrics;
}

export interface PromptMetrics {
  invocations: number;
  avgResponseTimeMs: number;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  avgConfidence: number;
}

export interface PromptRegistry {
  agentId: string;
  currentVariant: string;
  variants: Map<string, PromptVariant>;
}

const registries = new Map<string, PromptRegistry>();

export function createPromptVariant(
  _agentId: string,
  variantId: string,
  name: string,
  systemPrompt: string,
  weight: number = 100,
): PromptVariant {
  return {
    id: variantId,
    name,
    systemPrompt,
    weight,
    metrics: {
      invocations: 0,
      avgResponseTimeMs: 0,
      votesFor: 0,
      votesAgainst: 0,
      votesAbstain: 0,
      avgConfidence: 0,
    },
  };
}

export function registerAgentPrompts(agentId: string, variants: PromptVariant[]): void {
  const registry: PromptRegistry = {
    agentId,
    currentVariant: variants[0]?.id || "default",
    variants: new Map(variants.map((v) => [v.id, v])),
  };
  registries.set(agentId, registry);
}

export function getPromptRegistry(agentId: string): PromptRegistry | undefined {
  return registries.get(agentId);
}

export function getPromptVariant(agentId: string, variantId?: string): PromptVariant | undefined {
  const registry = registries.get(agentId);
  if (!registry) return undefined;

  if (variantId) {
    return registry.variants.get(variantId);
  }

  // A/B testing: select variant based on weights
  return selectVariantByWeight(registry);
}

export function getSystemPrompt(agent: DAOAgent, variantId?: string): string {
  const variant = getPromptVariant(agent.id, variantId);
  if (variant) {
    return variant.systemPrompt;
  }
  return agent.systemPrompt;
}

function selectVariantByWeight(registry: PromptRegistry): PromptVariant | undefined {
  const variants = Array.from(registry.variants.values());
  if (variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0];

  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  const random = Math.random() * totalWeight;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (random <= cumulative) {
      return variant;
    }
  }

  return variants[variants.length - 1];
}

export function recordPromptInvocation(
  agentId: string,
  variantId: string,
  durationMs: number,
  vote?: { position: string; confidence?: number },
): void {
  const registry = registries.get(agentId);
  if (!registry) return;

  const variant = registry.variants.get(variantId);
  if (!variant) return;

  const m = variant.metrics;
  m.invocations++;

  // Update running average of response time
  m.avgResponseTimeMs = (m.avgResponseTimeMs * (m.invocations - 1) + durationMs) / m.invocations;

  if (vote) {
    if (vote.position === "for") m.votesFor++;
    else if (vote.position === "against") m.votesAgainst++;
    else m.votesAbstain++;

    if (vote.confidence !== undefined) {
      const totalVotes = m.votesFor + m.votesAgainst + m.votesAbstain;
      m.avgConfidence = (m.avgConfidence * (totalVotes - 1) + vote.confidence) / totalVotes;
    }
  }
}

export function compareVariants(agentId: string): { variant: PromptVariant; score: number }[] {
  const registry = registries.get(agentId);
  if (!registry) return [];

  return Array.from(registry.variants.values())
    .map((variant) => {
      const m = variant.metrics;
      const totalVotes = m.votesFor + m.votesAgainst + m.votesAbstain;

      // Composite score: approval rate * confidence * invocations factor
      const approvalRate = totalVotes > 0 ? m.votesFor / totalVotes : 0;
      const confidenceFactor = m.avgConfidence / 10; // normalize 0-10 to 0-1
      const volumeFactor = Math.min(1, m.invocations / 10); // normalize to 0-1

      const score = approvalRate * 0.4 + confidenceFactor * 0.3 + volumeFactor * 0.3;

      return { variant, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function promoteBestVariant(agentId: string): PromptVariant | undefined {
  const comparison = compareVariants(agentId);
  if (comparison.length === 0) return undefined;

  const best = comparison[0];
  if (!best) return undefined;
  const registry = registries.get(agentId);
  if (registry) {
    registry.currentVariant = best.variant.id;
  }

  return best.variant;
}

export function formatPromptComparison(agentId: string): string {
  const comparison = compareVariants(agentId);
  if (comparison.length === 0) return "No prompt variants registered for this agent.";

  let output = `# 🧪 Prompt A/B Test Results — ${agentId}\n\n`;
  output += "| Variant | Weight | Invocations | Avg Time | Approval | Confidence | Score |\n";
  output += "|---------|--------|-------------|----------|----------|------------|-------|\n";

  for (const { variant, score } of comparison) {
    const m = variant.metrics;
    const totalVotes = m.votesFor + m.votesAgainst + m.votesAbstain;
    const approval = totalVotes > 0 ? `${Math.round((m.votesFor / totalVotes) * 100)}%` : "N/A";
    output += `| ${variant.name} | ${variant.weight}% | ${m.invocations} | ${Math.round(m.avgResponseTimeMs)}ms | ${approval} | ${m.avgConfidence.toFixed(1)} | ${score.toFixed(2)} |\n`;
  }

  const best = comparison[0];
  if (!best) return output;
  output += `\n**Best variant:** ${best.variant.name} (score: ${best.score.toFixed(2)})`;

  return output;
}

export function resetPromptRegistries(): void {
  registries.clear();
}
