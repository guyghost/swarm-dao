import { describe, expect, it } from "bun:test";
import {
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
});
