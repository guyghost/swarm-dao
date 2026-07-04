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
});
