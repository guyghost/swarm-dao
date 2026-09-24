import { describe, expect, it } from "bun:test";
import { executeAmendment, previewAmendment, validateAmendmentPayload } from "../src/governance/amendments.js";
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

  it("rejects non-numeric or out-of-range agent weights", () => {
    const badUpdate = [
      { weight: "5" as never },
      { weight: Number.NaN },
      { weight: Number.POSITIVE_INFINITY },
      { weight: 0 },
      { weight: 11 },
    ];
    for (const changes of badUpdate) {
      expect(validateAmendmentPayload({ type: "agent-update", agentId: "architect", changes }).valid).toBe(false);
    }
    expect(validateAmendmentPayload({ type: "agent-update", agentId: "architect", changes: { weight: 5 } }).valid).toBe(
      true,
    );

    expect(
      validateAmendmentPayload({
        type: "agent-add",
        agent: { id: "new", name: "New", role: "r", weight: 0, description: "d", systemPrompt: "" },
      }).valid,
    ).toBe(false);
  });

  it("refuses to add a duplicate agent id", () => {
    const state = createInitialState(process.cwd());
    state.agents = [{ id: "architect", name: "Architect", role: "r", description: "d", systemPrompt: "sp", weight: 3 }];
    const result = executeAmendment(
      {
        type: "agent-add",
        agent: { id: "architect", name: "Duplicate", role: "r", weight: 1, description: "d", systemPrompt: "" },
      },
      state,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
    expect(state.agents).toHaveLength(1);
  });
});
