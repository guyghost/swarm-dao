import { describe, expect, it } from "bun:test";
import {
  calculateCompositeScore,
  calculateRICEScore,
  formatRICEScore,
  parseRICEFromOutput,
  parseScoresFromOutput,
  rankByRICE,
} from "../src/governance/scoring.js";

describe("governance/scoring.ts", () => {
  it("parses and formats scoring values", () => {
    const scores = parseScoresFromOutput("userImpact: 8 businessImpact: 7 effort: 4 securityRisk: 3 confidence: 9");
    expect(scores.userImpact).toBe(8);

    const rice = calculateRICEScore(1000, 4, 80, 20);
    expect(rice.riceScore).toBeGreaterThan(0);
    expect(formatRICEScore(rice)).toContain("RICE Score");

    const parsedRice = parseRICEFromOutput("RICE reach: 200 impact: 3 confidence: 70 effort: 10");
    expect(parsedRice.reach).toBe(200);

    const ranked = rankByRICE([
      { id: 1, riceScore: rice },
      { id: 2, riceScore: calculateRICEScore(100, 2, 60, 10) },
    ]);
    expect(ranked[0]?.rank).toBe(1);
  });

  it("parseScoresFromOutput: single pass captures all axes, orderings, formats, and edge cases (parity)", () => {
    const cases = [
      {
        name: "all five axes",
        input: "userImpact: 8 businessImpact: 7 effort: 4 securityRisk: 3 confidence: 9",
        expected: { userImpact: 8, businessImpact: 7, effort: 4, securityRisk: 3, confidence: 9 },
      },
      { name: "missing axes stay absent", input: "userImpact: 8 effort: 4", expected: { userImpact: 8, effort: 4 } },
      { name: "decimal values", input: "effort: 4.5 confidence: 7.25", expected: { effort: 4.5, confidence: 7.25 } },
      { name: "over-range clamps to 10", input: "userImpact: 12", expected: { userImpact: 10 } },
      // The value group has no leading `-`, so a negative literal is never
      // captured and the axis stays absent. This matches the pre-change
      // per-axis regex exactly (it is NOT clamped to 0).
      { name: "negative literal not captured -> absent", input: "securityRisk: -3", expected: {} },
      {
        name: "reversed order still captures all (single pass)",
        input: "confidence: 9 securityRisk: 3 effort: 4 businessImpact: 7 userImpact: 8",
        expected: { userImpact: 8, businessImpact: 7, effort: 4, securityRisk: 3, confidence: 9 },
      },
      // First occurrence wins, mirroring the former non-global per-axis .match.
      {
        name: "duplicate keys keep FIRST occurrence",
        input: "userImpact: 8 userImpact: 3",
        expected: { userImpact: 8 },
      },
      { name: "colon-separated, no space", input: "effort:4", expected: { effort: 4 } },
      { name: "space-separated, no colon", input: "effort 4", expected: { effort: 4 } },
      { name: "no axes -> empty partial", input: "hello world, nothing to parse here", expected: {} },
    ];
    for (const { name, input, expected } of cases) {
      expect(parseScoresFromOutput(input), name).toEqual(expected);
    }
  });

  it("calculateCompositeScore: single-reduce averages match the hand-computed formula (parity)", () => {
    // Two valid outputs:
    //   out1: userImpact 8, businessImpact 7, effort 4, securityRisk 3, confidence 9
    //   out2: userImpact 6, businessImpact 5, effort 6, securityRisk 2, confidence 8
    // Averages: userImpact 7, businessImpact 6, effort 5, securityRisk 2.5, confidence 8.5
    // Inversions: normalizedEffort = 10 - 5 = 5.0 ; normalizedSecurityRisk = 10 - 2.5 = 7.5
    // Weighted   = 7*0.3 + 6*0.2 + 5*0.15 + 7.5*0.2 + 8.5*0.15
    //            = 2.1 + 1.2 + 0.75 + 1.5 + 1.275 = 6.825 -> round(68.25)/10 = 6.8
    // riskZone   : 6.8 >= 4.0 -> "orange"
    const result = calculateCompositeScore([
      { content: "userImpact: 8 businessImpact: 7 effort: 4 securityRisk: 3 confidence: 9" },
      { content: "userImpact: 6 businessImpact: 5 effort: 6 securityRisk: 2 confidence: 8" },
    ]);
    expect(result.axes).toEqual({ userImpact: 7, businessImpact: 6, effort: 5, securityRisk: 2.5, confidence: 8.5 });
    expect(result.weighted).toBe(6.8);
    expect(result.riskZone).toBe("orange");
    expect(result.breakdown).toBe("7.0×0.3 + 6.0×0.2 + 5.0×0.15 + 7.5×0.2 + 8.5×0.15 = 6.8");
  });
});
