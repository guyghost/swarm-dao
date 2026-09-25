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
    for (const text of [
      "Add author field",
      "Author attribution and authority",
      "Authoritative source metadata",
      "Authorship analytics",
    ]) {
      const proposal: Proposal = {
        ...base,
        type: "product-feature",
        title: text,
        description: "Show the article author",
      };
      // Word-boundary auth matching: "author"/"authority"/"authoritative" must
      // not match the security "auth" family.
      expect(classifyRiskZone(proposal)).toBe("orange");
    }
  });

  it("still classifies the auth family and its compounds as red", () => {
    for (const title of [
      "Authentication flow",
      "Authorization rules",
      "Fix unauthorized access",
      "Add OAuth login",
      "Handle reauthentication",
      "Deauthorize revoked sessions",
    ]) {
      const proposal: Proposal = { ...base, type: "product-feature", title, description: "d" };
      expect(classifyRiskZone(proposal)).toBe("red");
    }
  });

  it("classifies sensitive problem statements and acceptance criteria as red", () => {
    const proposal: Proposal = {
      ...base,
      type: "product-feature",
      title: "Improve account recovery",
      description: "Reduce support requests",
      problemStatement: "Password reset tokens are currently stored in plaintext",
      acceptanceCriteria: ["Encrypt every recovery token before persistence"],
    };

    expect(classifyRiskZone(proposal)).toBe("red");
  });

  it("keeps substring keyword coverage for compound terms", () => {
    for (const title of [
      "Cybersecurity hardening",
      "Rotate the API token",
      "Passwordless login",
      "Store credentials",
    ]) {
      const proposal: Proposal = { ...base, type: "product-feature", title, description: "d" };
      expect(classifyRiskZone(proposal)).toBe("red");
    }
  });
});
