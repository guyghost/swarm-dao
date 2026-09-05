// ============================================================
// Swarm DAO Core — Composite & RICE Scoring
// ============================================================

import type { AgentOutput, AxisScore, CompositeScore, RICEScore, RiskZone } from "../types/index.js";
import { RISK_ZONE_LABELS, SCORING_WEIGHTS } from "../types/index.js";

// ── Composite Score ──────────────────────────────────────────

const _SCORE_PATTERN = /##\s*Composite Score Inputs \(0-10\)\s*\n([\s\S]*?)(?=\n##|$)/i;
// Single combined alternation scanned once via matchAll, replacing the former
// per-axis loop (5 full regex scans of the content). The separator `[:\s]+` is
// preserved verbatim so `key: n`, `key:n`, and `key n` keep matching exactly.
const SCORE_TOKEN_RE = /(userImpact|businessImpact|effort|securityRisk|confidence)[:\s]+(\d+(?:\.\d+)?)/gi;
const AXIS_KEY_BY_LOWER: Readonly<Record<string, keyof AxisScore>> = {
  userimpact: "userImpact",
  businessimpact: "businessImpact",
  effort: "effort",
  securityrisk: "securityRisk",
  confidence: "confidence",
};

export function parseScoresFromOutput(content: string): Partial<AxisScore> {
  const scores: Partial<AxisScore> = {};
  if (!content) return scores;
  for (const match of content.matchAll(SCORE_TOKEN_RE)) {
    const axis = AXIS_KEY_BY_LOWER[(match[1] ?? "").toLowerCase()];
    // First occurrence wins, mirroring the previous non-global per-axis `.match`,
    // which returned only the first match per axis.
    if (axis !== undefined && !(axis in scores)) {
      scores[axis] = Math.min(10, Math.max(0, parseFloat(match[2] ?? "0")));
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

  // Single reduce accumulating per-axis sums, then one division each —
  // replaces the former five separate `reduce` passes over validScores.
  // Addition order is identical, so floating-point results are bit-for-bit
  // unchanged.
  const sums = validScores.reduce<AxisScore>(
    (acc, s) => {
      acc.userImpact += s.userImpact || 0;
      acc.businessImpact += s.businessImpact || 0;
      acc.effort += s.effort || 0;
      acc.securityRisk += s.securityRisk || 0;
      acc.confidence += s.confidence || 0;
      return acc;
    },
    { userImpact: 0, businessImpact: 0, effort: 0, securityRisk: 0, confidence: 0 },
  );
  const n = validScores.length;

  const axes: AxisScore = {
    userImpact: sums.userImpact / n,
    businessImpact: sums.businessImpact / n,
    effort: sums.effort / n,
    securityRisk: sums.securityRisk / n,
    confidence: sums.confidence / n,
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

  const riskZone: RiskZone = weighted >= 7.0 ? "green" : weighted >= 4.0 ? "orange" : "red";

  return {
    axes,
    weighted: Math.round(weighted * 10) / 10,
    riskZone,
    breakdown: `${axes.userImpact.toFixed(1)}×${SCORING_WEIGHTS.userImpact} + ${axes.businessImpact.toFixed(1)}×${SCORING_WEIGHTS.businessImpact} + ${normalizedEffort.toFixed(1)}×${SCORING_WEIGHTS.effort} + ${normalizedSecurityRisk.toFixed(1)}×${SCORING_WEIGHTS.securityRisk} + ${axes.confidence.toFixed(1)}×${SCORING_WEIGHTS.confidence} = ${weighted.toFixed(1)}`,
  };
}

export function formatCompositeScore(score: CompositeScore): string {
  return `## Composite Score

**Weighted:** ${score.weighted}/10
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
  const parsed: Partial<RICEScore> = {};
  if (!content) return parsed;
  // Line-oriented scan (ReDoS-safe): jump to the first line mentioning RICE,
  // then read metric lines — no [\s\S]*? backtracking over unbounded input.
  const lines = content.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (!inSection && /rice/i.test(line)) inSection = true;
    if (!inSection) continue;
    // The activating line can itself carry the metrics ("RICE reach: 200 …").
    if (parsed.reach === undefined) {
      const reach = line.match(/reach[ \t]*:[ \t]*(\d+)|reach[ \t]+(\d+)/i);
      if (reach) parsed.reach = parseInt(reach[1] ?? reach[2] ?? "0", 10);
    }
    if (parsed.impact === undefined) {
      const impact = line.match(/impact[ \t]*:[ \t]*(\d+)|impact[ \t]+(\d+)/i);
      if (impact) parsed.impact = parseInt(impact[1] ?? impact[2] ?? "0", 10);
    }
    if (parsed.confidence === undefined) {
      const confidence = line.match(/confidence[ \t]*:[ \t]*(\d+)|confidence[ \t]+(\d+)/i);
      if (confidence) parsed.confidence = parseInt(confidence[1] ?? confidence[2] ?? "0", 10);
    }
    if (parsed.effort === undefined) {
      const effort = line.match(/effort[ \t]*:[ \t]*(\d+(?:\.\d+)?)|effort[ \t]+(\d+(?:\.\d+)?)/i);
      if (effort) parsed.effort = parseFloat(effort[1] ?? effort[2] ?? "0");
    }
    if (
      parsed.reach !== undefined &&
      parsed.impact !== undefined &&
      parsed.confidence !== undefined &&
      parsed.effort !== undefined
    ) {
      break;
    }
  }
  return parsed;
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
