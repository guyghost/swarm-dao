import { describe, expect, it } from "bun:test";
import { previewAmendment, validateAmendmentPayload } from "../src/governance/amendments.js";
import { createInitialState } from "../src/types/index.js";

describe("governance/amendments.ts", () => {
  it("validates and previews amendment payload", () => {
    const state = createInitialState(process.cwd());
    state.agents = [
      {
        id: "architect",
        name: "Architect",
        role: "Architecture",
        description: "d",
        systemPrompt: "sp",
        weight: 3,
      },
    ];
    const payload = {
      type: "agent-update" as const,
      agentId: "architect",
      changes: { weight: 5 },
    };
    const validation = validateAmendmentPayload(payload);
    expect(validation.valid).toBe(true);
    const preview = previewAmendment(payload, state);
    expect(preview.length).toBeGreaterThan(0);
  });

  it("rejects a non-positive maxConcurrent in a config-update amendment", () => {
    for (const maxConcurrent of [0, -1, 1.5, Number.NaN]) {
      const validation = validateAmendmentPayload({
        type: "config-update",
        changes: { maxConcurrent },
      });
      expect(validation.valid).toBe(false);
      expect(validation.errors.join("\n")).toContain("maxConcurrent");
    }
    expect(validateAmendmentPayload({ type: "config-update", changes: { maxConcurrent: 4 } }).valid).toBe(true);
  });
});
