import { describe, expect, it } from "bun:test";
import { classifyRiskZone, statusLabel } from "../src/governance/lifecycle.js";
import type { Proposal } from "../src/types/index.js";

// Transitions no longer live here — the XState machine
// (proposal.machine.ts) is the sole source of truth, exercised via
// dispatchProposalEvent (see proposal.machine.test.ts). What remains
// in lifecycle.ts are the risk/label helpers the control layer uses.

describe("governance/lifecycle.ts (risk + label helpers)", () => {
  const base: Proposal = {
    id: 1,
    title: "Security hardening",
    type: "security-change",
    description: "desc",
    proposedBy: "user",
    status: "open",
    votes: [],
    agentOutputs: [],
    createdAt: new Date().toISOString(),
  };

  it("classifies security-change proposals into the red risk zone", () => {
    expect(classifyRiskZone(base)).toBe("red");
  });

  it("returns a human label for a status", () => {
    expect(statusLabel("open")).toContain("Open");
    expect(statusLabel("approved")).toContain("Approved");
  });

  it("does not send a proposal to the red zone just for the word 'author'", () => {
    const proposal: Proposal = {
      ...base,
      type: "product-feature",
      title: "Add author field",
      description: "Show the article author and its authoritative source",
    };
    // Word-boundary matching: "author"/"authoritative" must not match "auth".
    expect(classifyRiskZone(proposal)).toBe("orange");
  });

  it("still classifies authentication/authorization wording as red", () => {
    for (const title of ["Authentication flow", "Authorization rules", "Rotate the API token", "Password reset"]) {
      const proposal: Proposal = { ...base, type: "product-feature", title, description: "d" };
      expect(classifyRiskZone(proposal)).toBe("red");
    }
  });
});
