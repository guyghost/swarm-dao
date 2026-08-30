import { describe, expect, test } from "bun:test";
import { evaluateEditGate, normalizeEditPath } from "../src/governance/edit-gate.js";

const CRITICAL = ["src/auth/**", "src/payment/**", ".env*"];
const approved = (proposalId: number, affectedPaths?: string[], status = "approved") => ({
  proposalId,
  affectedPaths,
  status,
});

describe("evaluateEditGate", () => {
  test("opt-in (default) allows everything, flagging critical paths informationally", () => {
    const decision = evaluateEditGate({
      paths: ["src/auth/login.ts", "docs/readme.md"],
      mode: "opt-in",
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.verdicts).toHaveLength(2);
    expect(decision.verdicts[0]).toMatchObject({ path: "src/auth/login.ts", critical: true, allowed: true });
    expect(decision.verdicts[1]).toMatchObject({ path: "docs/readme.md", critical: false, allowed: true });
    expect(decision.guidance).toBeNull();
  });

  test("suggest allows everything but nudges a proposal for uncovered critical paths", () => {
    const decision = evaluateEditGate({
      paths: ["src/payment/charge.ts"],
      mode: "suggest",
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.verdicts[0]?.allowed).toBe(true);
    expect(decision.verdicts[0]?.reason).toContain("critical");
    expect(decision.guidance).toContain("propose");
  });

  test("enforce denies uncovered critical paths and explains how to proceed", () => {
    const decision = evaluateEditGate({
      paths: ["src/auth/login.ts", ".env.local"],
      mode: "enforce",
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.allowed).toBe(false);
    for (const verdict of decision.verdicts) {
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("enforce");
    }
    expect(decision.guidance).toContain("proposal");
  });

  test("enforce allows a critical path covered by an approved proposal's affectedPaths", () => {
    const decision = evaluateEditGate({
      paths: ["src/auth/login.ts"],
      mode: "enforce",
      criticalPaths: CRITICAL,
      approved: [approved(7, ["src/auth/**"])],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.verdicts[0]).toMatchObject({ allowed: true, coveredByProposalId: 7 });
    expect(decision.verdicts[0]?.reason).toContain("#7");
  });

  test("only decided/executing statuses count as approval authority", () => {
    for (const status of ["open", "deliberating", "rejected", "failed"]) {
      const decision = evaluateEditGate({
        paths: ["src/auth/login.ts"],
        mode: "enforce",
        criticalPaths: CRITICAL,
        approved: [approved(1, ["src/auth/**"], status)],
      });
      expect(decision.allowed).toBe(false);
    }
    for (const status of ["approved", "controlled", "executed"]) {
      const decision = evaluateEditGate({
        paths: ["src/auth/login.ts"],
        mode: "enforce",
        criticalPaths: CRITICAL,
        approved: [approved(1, ["src/auth/**"], status)],
      });
      expect(decision.allowed).toBe(true);
    }
  });

  test("non-critical paths are always allowed, even in enforce mode", () => {
    const decision = evaluateEditGate({
      paths: ["README.md", "src/components/button.tsx"],
      mode: "enforce",
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.verdicts.every((v) => v.allowed)).toBe(true);
  });

  test("mixed paths produce a per-path verdict and a correct overall flag", () => {
    const decision = evaluateEditGate({
      paths: ["README.md", "src/payment/api.ts"],
      mode: "enforce",
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.verdicts.map((v) => v.allowed)).toEqual([true, false]);
    expect(decision.allowed).toBe(false);
  });

  test("empty and duplicate paths are handled deterministically", () => {
    const decision = evaluateEditGate({
      paths: ["src/auth/a.ts", "src/auth/a.ts", "", "  "],
      mode: "enforce",
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.verdicts.map((v) => v.path)).toEqual(["src/auth/a.ts"]);
    expect(decision.allowed).toBe(false);
  });

  test("suggest mode is quiet when nothing critical is touched", () => {
    const decision = evaluateEditGate({
      paths: ["docs/guide.md"],
      mode: "suggest",
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.guidance).toBeNull();
  });

  test("alias spellings are normalized before glob matching (no bypass)", () => {
    const decision = evaluateEditGate({
      paths: ["src/public/../auth/login.ts", "./src/auth/login.ts", "src//auth//login.ts", "src/auth/"],
      mode: "enforce",
      criticalPaths: CRITICAL,
      approved: [],
    });
    // Every alias resolves into the critical tree and is blocked. The bare
    // directory form normalizes to its own path and still matches src/auth/**.
    expect(decision.verdicts.length).toBeGreaterThanOrEqual(1);
    expect(decision.verdicts.every((v) => v.critical && !v.allowed)).toBe(true);
    expect(decision.verdicts[0]).toMatchObject({ path: "src/auth/login.ts", critical: true, allowed: false });
    expect(decision.allowed).toBe(false);
  });

  test("unmatchable paths are refused in every mode, never allowed", () => {
    for (const mode of ["opt-in", "suggest", "enforce"] as const) {
      const decision = evaluateEditGate({
        paths: ["/etc/passwd", "C:\\Windows\\secret", "../outside/repo.ts", ".", "\\\\server\\share"],
        mode,
        criticalPaths: CRITICAL,
        approved: [],
      });
      expect(decision.allowed).toBe(false);
      expect(decision.verdicts.every((v) => !v.allowed)).toBe(true);
      expect(decision.verdicts.every((v) => v.reason.startsWith("unmatchable path"))).toBe(true);
    }
  });

  test("normalizeEditPath resolves and rejects deterministically", () => {
    expect(normalizeEditPath("src/./a/../b/c.ts")).toEqual({ ok: true, path: "src/b/c.ts" });
    expect(normalizeEditPath("src/a/")).toEqual({ ok: true, path: "src/a" });
    expect(normalizeEditPath("/abs/path")).toMatchObject({ ok: false });
    expect(normalizeEditPath("..")).toMatchObject({ ok: false });
    expect(normalizeEditPath("")).toMatchObject({ ok: false });
    expect(normalizeEditPath("a\\b")).toMatchObject({ ok: false });
  });

  test("unknown modes fail open to opt-in (consistent with canEditWithoutProposal)", () => {
    const decision = evaluateEditGate({
      paths: ["src/auth/login.ts"],
      mode: "enforse" as never,
      criticalPaths: CRITICAL,
      approved: [],
    });
    expect(decision.mode).toBe("opt-in");
    expect(decision.allowed).toBe(true);
  });
});
