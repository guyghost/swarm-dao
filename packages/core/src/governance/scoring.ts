// ============================================================
// Swarm DAO Core — Composite & RICE Scoring
// ============================================================

import type { AgentOutput, AxisScore, CompositeScore, RICEScore, RiskZone } from "../types/index.js";
import { RISK_ZONE_LABELS, SCORING_WEIGHTS } from "../types/index.js";

// ── Composite Score ──────────────────────────────────────────

const _SCORE_PATTERN = /##\s*Composite Score Inputs \(0-10\)\s*\n([\s\S]*?)(?=\n##|$)/i;
const AXIS_PATTERNS: Record<keyof AxisScore, RegExp> = {
  userImpact: /userImpact[:\s]+(\d+(?:\.\d+)?)/i,
  businessImpact: /businessImpact[:\s]+(\d+(?:\.\d+)?)/i,
  effort: /effort[:\s]+(\d+(?:\.\d+)?)/i,
  securityRisk: /securityRisk[:\s]+(\d+(?:\.\d+)?)/i,
  confidence: /confidence[:\s]+(\d+(?:\.\d+)?)/i,
};

export function parseScoresFromOutput(content: string): Partial<AxisScore> {
  const scores: Partial<AxisScore> = {};
  for (const [axis, pattern] of Object.entries(AXIS_PATTERNS) as [keyof AxisScore, RegExp][]) {
    const match = content?.match(pattern);
    if (match) {
      scores[axis] = Math.min(10, Math.max(0, parseFloat(match[1] ?? "0")));
    }
  }
  return scores;
}

export function calculateCompositeScore(outputs: AgentOutput[]): CompositeScore {
  const allScores: Partial<AxisScore>[] = outputs
    .filter((o) => !o.error && o.content)
    .map((o) => parseScoresFromOutput(o.content));

  const validScores = allScores.filter(
    (s) =>
      s.userImpact !== undefined &&
      s.businessImpact !== undefined &&
      s.effort !== undefined &&
      s.securityRisk !== undefined &&
      s.confidence !== undefined,
  );

  if (validScores.length === 0) {
    return {
      axes: { userImpact: 0, businessImpact: 0, effort: 0, securityRisk: 0, confidence: 0 },
      weighted: 0,
      riskZone: "red",
      breakdown: "No valid scores provided",
    };
  }

  const avg = (key: keyof AxisScore): number =>
    validScores.reduce((sum, s) => sum + (s[key] || 0), 0) / validScores.length;

  const axes: AxisScore = {
    userImpact: avg("userImpact"),
    businessImpact: avg("businessImpact"),
    effort: avg("effort"),
    securityRisk: avg("securityRisk"),
    confidence: avg("confidence"),
  };

  // Invert effort and securityRisk (lower is better)
  const normalizedEffort = 10 - axes.effort;
  const normalizedSecurityRisk = 10 - axes.securityRisk;

  const weighted =
    axes.userImpact * SCORING_WEIGHTS.userImpact +
    axes.businessImpact * SCORING_WEIGHTS.businessImpact +
    normalizedEffort * SCORING_WEIGHTS.effort +
    normalizedSecurityRisk * SCORING_WEIGHTS.securityRisk +
    axes.confidence * SCORING_WEIGHTS.confidence;

  const riskZone: RiskZone = weighted >= 70 ? "green" : weighted >= 40 ? "orange" : "red";

  return {
    axes,
    weighted: Math.round(weighted * 10) / 10,
    riskZone,
    breakdown: `${axes.userImpact.toFixed(1)}×${SCORING_WEIGHTS.userImpact} + ${axes.businessImpact.toFixed(1)}×${SCORING_WEIGHTS.businessImpact} + ${normalizedEffort.toFixed(1)}×${SCORING_WEIGHTS.effort} + ${normalizedSecurityRisk.toFixed(1)}×${SCORING_WEIGHTS.securityRisk} + ${axes.confidence.toFixed(1)}×${SCORING_WEIGHTS.confidence} = ${weighted.toFixed(1)}`,
  };
}

export function formatCompositeScore(score: CompositeScore): string {
  return `## Composite Score

**Weighted:** ${score.weighted}/100
**Zone:** ${RISK_ZONE_LABELS[score.riskZone]}

### Axes
| Axis | Score | Weight |
|------|-------|--------|
| User Impact | ${score.axes.userImpact.toFixed(1)} | ${SCORING_WEIGHTS.userImpact} |
| Business Impact | ${score.axes.businessImpact.toFixed(1)} | ${SCORING_WEIGHTS.businessImpact} |
| Effort (inverted) | ${(10 - score.axes.effort).toFixed(1)} | ${SCORING_WEIGHTS.effort} |
| Security Risk (inv) | ${(10 - score.axes.securityRisk).toFixed(1)} | ${SCORING_WEIGHTS.securityRisk} |
| Confidence | ${score.axes.confidence.toFixed(1)} | ${SCORING_WEIGHTS.confidence} |

**Formula:** ${score.breakdown}`;
}

// ── RICE Scoring ─────────────────────────────────────────────

export function calculateRICEScore(reach: number, impact: number, confidence: number, effort: number): RICEScore {
  const riceScore = (reach * impact * (confidence / 100)) / effort;
  return {
    reach,
    impact: Math.min(10, Math.max(1, impact)),
    confidence: Math.min(100, Math.max(0, confidence)),
    effort: Math.max(0.1, effort),
    riceScore: Math.round(riceScore * 10) / 10,
  };
}

export function parseRICEFromOutput(content: string): Partial<RICEScore> {
  const reachMatch = content?.match(/RICE[\s\S]*?reach[:\s]+(\d+)/i);
  const impactMatch = content?.match(/RICE[\s\S]*?impact[:\s]+(\d+)/i);
  const confidenceMatch = content?.match(/RICE[\s\S]*?confidence[:\s]+(\d+)/i);
  const effortMatch = content?.match(/RICE[\s\S]*?effort[:\s]+(\d+(?:\.\d+)?)/i);

  return {
    reach: reachMatch ? parseInt(reachMatch[1] ?? "0", 10) : undefined,
    impact: impactMatch ? parseInt(impactMatch[1] ?? "0", 10) : undefined,
    confidence: confidenceMatch ? parseInt(confidenceMatch[1] ?? "0", 10) : undefined,
    effort: effortMatch ? parseFloat(effortMatch[1] ?? "0") : undefined,
  };
}

export function rankByRICE(
  proposals: { id: number; riceScore?: RICEScore }[],
): { id: number; riceScore: RICEScore; rank: number }[] {
  const scored = proposals
    .filter((p): p is { id: number; riceScore: RICEScore } => p.riceScore !== undefined)
    .map((p) => ({ id: p.id, riceScore: p.riceScore, rank: 0 }));

  scored.sort((a, b) => b.riceScore.riceScore - a.riceScore.riceScore);
  scored.forEach((item, index) => {
    item.rank = index + 1;
  });

  return scored;
}

export function formatRICEScore(score: RICEScore): string {
  return `**RICE Score:** ${score.riceScore.toFixed(1)} (Reach: ${score.reach} × Impact: ${score.impact} × Confidence: ${score.confidence}% / Effort: ${score.effort})`;
}
