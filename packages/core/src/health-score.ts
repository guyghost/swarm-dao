// ============================================================
// Swarm DAO Core — Health Score & Dashboard
// ============================================================

import { getState, saveState } from "./persistence.js";
import type {
  HealthMetric,
  HealthScore,
  HealthSnapshot,
  HealthWeights,
  Proposal,
  ProposalOutcome,
} from "./types/index.js";

export const DEFAULT_HEALTH_WEIGHTS: HealthWeights = {
  passRate: 25,
  avgRating: 25,
  deliberationDepth: 25,
  participation: 25,
};

export function validateWeights(weights: Partial<HealthWeights>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const values = Object.values(weights).filter((v) => v !== undefined) as number[];
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum !== 100) errors.push(`Weights must sum to 100, got ${sum}`);
  for (const [k, v] of Object.entries(weights)) {
    if (v !== undefined && (v < 0 || v > 100)) errors.push(`${k} must be 0-100`);
  }
  return { valid: errors.length === 0, errors };
}

export function computeHealthScore(
  proposals: Proposal[],
  outcomes: Record<number, ProposalOutcome>,
  weights: HealthWeights = DEFAULT_HEALTH_WEIGHTS,
): HealthScore {
  const resolved = proposals.filter((p) => p.status === "executed" || p.status === "rejected" || p.status === "failed");
  const executed = proposals.filter((p) => p.status === "executed");

  if (resolved.length === 0) {
    return {
      score: 0,
      label: "No Data",
      metrics: [],
      insufficientData: true,
      proposalCount: proposals.length,
    };
  }

  // Pass rate: % of resolved that were executed
  const passRateRaw = resolved.length > 0 ? (executed.length / resolved.length) * 100 : 0;

  // Avg rating: average of outcome ratings
  const allRatings = Object.values(outcomes).flatMap((o) => o.ratings);
  const avgRatingRaw =
    allRatings.length > 0
      ? (allRatings.reduce((sum, r) => sum + r.score, 0) / allRatings.length) * 20 // scale 1-5 to 0-100
      : 0;

  // Deliberation depth: avg agent outputs per proposal
  const avgOutputs =
    proposals.length > 0 ? proposals.reduce((sum, p) => sum + (p.agentOutputs?.length || 0), 0) / proposals.length : 0;
  const deliberationDepthRaw = Math.min(100, avgOutputs * 15); // 7 agents = ~100%

  // Participation: % of proposals that reached deliberation
  const deliberated = proposals.filter((p) => p.status !== "open").length;
  const participationRaw = proposals.length > 0 ? (deliberated / proposals.length) * 100 : 0;

  const metrics: HealthMetric[] = [
    {
      name: "Pass Rate",
      rawValue: passRateRaw,
      normalizedScore: passRateRaw,
      weight: weights.passRate,
      contribution: (passRateRaw * weights.passRate) / 100,
      displayValue: `${executed.length}/${resolved.length} executed`,
    },
    {
      name: "Avg Rating",
      rawValue: avgRatingRaw,
      normalizedScore: avgRatingRaw,
      weight: weights.avgRating,
      contribution: (avgRatingRaw * weights.avgRating) / 100,
      displayValue: allRatings.length > 0 ? `${(avgRatingRaw / 20).toFixed(1)}/5` : "No ratings",
    },
    {
      name: "Deliberation Depth",
      rawValue: deliberationDepthRaw,
      normalizedScore: deliberationDepthRaw,
      weight: weights.deliberationDepth,
      contribution: (deliberationDepthRaw * weights.deliberationDepth) / 100,
      displayValue: `${avgOutputs.toFixed(1)} avg outputs/proposal`,
    },
    {
      name: "Participation",
      rawValue: participationRaw,
      normalizedScore: participationRaw,
      weight: weights.participation,
      contribution: (participationRaw * weights.participation) / 100,
      displayValue: `${deliberated}/${proposals.length} deliberated`,
    },
  ];

  const score = Math.round(metrics.reduce((sum, m) => sum + m.contribution, 0));

  let label: string;
  if (score >= 80) label = "Healthy";
  else if (score >= 60) label = "Stable";
  else if (score >= 40) label = "At Risk";
  else label = "Critical";

  return {
    score,
    label,
    metrics,
    insufficientData: resolved.length < 3,
    proposalCount: proposals.length,
  };
}

export function formatHealthScore(score: HealthScore): string {
  let output = `# 🏥 DAO Health Score: ${score.score}/100 (${score.label})\n\n`;

  if (score.insufficientData) {
    output += `> ⚠️ Insufficient data (${score.proposalCount} proposals, need ≥3 resolved)\n\n`;
  }

  output += "## Metrics\n";
  output += "| Metric | Score | Weight | Contribution |\n";
  output += "|--------|-------|--------|-------------|\n";
  for (const m of score.metrics) {
    output += `| ${m.name} | ${m.normalizedScore.toFixed(1)} | ${m.weight}% | ${m.contribution.toFixed(1)} | ${m.displayValue}\n`;
  }

  return output;
}

export function getHealthTrend(snapshots: HealthSnapshot[]): { improving: boolean; change: number } {
  if (snapshots.length < 2) return { improving: false, change: 0 };
  const recent = snapshots.slice(-2);
  const change = (recent[1]?.score ?? 0) - (recent[0]?.score ?? 0);
  return { improving: change > 0, change };
}

export function formatHealthTrend(trend: { improving: boolean; change: number }): string {
  const arrow = trend.improving ? "📈" : trend.change < 0 ? "📉" : "➡️";
  const sign = trend.change > 0 ? "+" : "";
  return `${arrow} ${sign}${trend.change.toFixed(1)} points`;
}

export async function recordHealthSnapshot(): Promise<HealthSnapshot> {
  const state = getState();
  const score = computeHealthScore(state.proposals, state.outcomes, state.config.healthWeights);
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
  const weekKey = `${now.getFullYear()}-W${week.toString().padStart(2, "0")}`;

  const snapshot: HealthSnapshot = {
    weekKey,
    year: now.getFullYear(),
    week,
    score: score.score,
    metrics: score.metrics,
    proposalCount: score.proposalCount,
    createdAt: now.toISOString(),
  };

  if (!state.healthSnapshots) state.healthSnapshots = [];
  const existingIndex = state.healthSnapshots.findIndex((s) => s.weekKey === snapshot.weekKey);
  if (existingIndex !== -1) {
    state.healthSnapshots[existingIndex] = snapshot;
  } else {
    state.healthSnapshots.push(snapshot);
  }
  // Prune to last 52 snapshots to avoid unbounded growth
  if (state.healthSnapshots.length > 52) {
    state.healthSnapshots = state.healthSnapshots.slice(-52);
  }

  await saveState();
  return snapshot;
}

export function getHealthSnapshots(): HealthSnapshot[] {
  return getState().healthSnapshots ?? [];
}

export function getLatestHealthSnapshot(): HealthSnapshot | undefined {
  const snaps = getState().healthSnapshots;
  return snaps && snaps.length > 0 ? snaps[snaps.length - 1] : undefined;
}

export function generateDashboard(
  proposals: Proposal[],
  outcomes: Record<number, ProposalOutcome>,
  agents: { id: string; name: string; weight: number }[],
  snapshots?: HealthSnapshot[],
): string {
  const byStatus: Record<string, number> = {};
  for (const p of proposals) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  }

  const health = computeHealthScore(proposals, outcomes);

  let output = "# 🏛️ DAO Dashboard\n\n";
  output += `## Overview\n`;
  output += `- **Proposals:** ${proposals.length} total\n`;
  output += `- **Agents:** ${agents.length} active (${agents.reduce((s, a) => s + a.weight, 0)} total weight)\n`;
  output += `- **Health:** ${health.score}/100 ${health.label}\n\n`;

  output += `## Proposal Pipeline\n`;
  for (const [status, count] of Object.entries(byStatus)) {
    const emoji =
      { open: "📝", deliberating: "🗳️", approved: "✅", controlled: "🛡️", rejected: "❌", executed: "🚀", failed: "💥" }[
        status
      ] || "•";
    output += `- ${emoji} ${status}: ${count}\n`;
  }

  if (health.metrics.length > 0) {
    output += `\n## Health Metrics\n`;
    for (const m of health.metrics) {
      const bar = "█".repeat(Math.round(m.normalizedScore / 10)).padEnd(10, "░");
      output += `- ${m.name}: ${bar} ${m.normalizedScore.toFixed(0)}% (${m.displayValue})\n`;
    }
  }

  const openProposals = proposals.filter((p) => p.status === "open" || p.status === "deliberating");
  if (openProposals.length > 0) {
    output += `\n## Open Proposals\n`;
    for (const p of openProposals) {
      output += `- #${p.id}: ${p.title} (${p.type})\n`;
    }
  }

  // Show health trend if snapshots exist
  if (snapshots && snapshots.length >= 2) {
    output += `\n## Health Trend\n`;
    output += `${formatHealthTrend(getHealthTrend(snapshots))}\n`;
  }

  return output;
}
