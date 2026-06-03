import { beforeEach, describe, expect, it } from "bun:test";
import { previewAmendment, validateAmendmentPayload } from "../src/governance/amendments.js";
import { setState } from "../src/persistence.js";
import { createInitialState } from "../src/types/index.js";

describe("governance/amendments.ts", () => {
  beforeEach(() => {
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
    setState(state);
  });

  it("validates and previews amendment payload", () => {
    const payload = {
      type: "agent-update" as const,
      agentId: "architect",
      changes: { weight: 5 },
    };
    const validation = validateAmendmentPayload(payload);
    expect(validation.valid).toBe(true);
    const preview = previewAmendment(payload);
    expect(preview.length).toBeGreaterThan(0);
  });
});
