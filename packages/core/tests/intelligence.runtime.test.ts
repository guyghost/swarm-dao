// Contract tests for the agent-runtime model (models/agent-runtime.md).
// Approved at manifest hash 183507f568904059cba2084c5514d90568fa746c409feb2f6aa78784327274fa.
// Decision tables D1–D3, failure modes E1–E5, invariants I1–I6.
import { describe, expect, it } from "bun:test";
import type { ResolvedHarness } from "../src/intelligence/runtime.js";
import {
  buildRuntimeResolutionContext,
  describeHarnessResolution,
  HARNESS_MODEL_FLAGS,
  hostDefaultHarnessFor,
  isValidHarnessId,
  isValidModelFlag,
  isValidModelId,
  resolveAgentHarness,
  resolveAgentRuntime,
} from "../src/intelligence/runtime.js";
import type { DAOAgent } from "../src/types/index.js";

function expectResolved(res: ResolvedHarness | undefined): ResolvedHarness {
  if (!res) throw new Error("expected a harness resolution");
  return res;
}

const baseAgent: DAOAgent = {
  id: "critic",
  name: "Critic",
  role: "Security",
  description: "d",
  systemPrompt: "sp",
  weight: 2,
};

describe("agent-runtime validators (§4.1, §4.2, D3)", () => {
  it("accepts harness ids matching ^[a-z][a-z0-9_-]{0,31}$", () => {
    for (const id of ["pi", "claude", "codex", "copilot", "opencode", "a", "gemini-3", "cursor_cli", "x".repeat(32)]) {
      expect(isValidHarnessId(id)).toBe(true);
    }
  });

  it("rejects unsafe or malformed harness ids (E1)", () => {
    for (const id of [
      "", // empty
      "-pi", // leading dash (option injection)
      "Pi", // uppercase
      "pi claude", // whitespace / multi-token
      "pi;rm", // metacharacters
      "pi$FOO",
      "pi|cat",
      "pi&ls",
      "pi`id`",
      "../escape",
      "pi\0x", // null byte
      "x".repeat(33), // overlong
    ]) {
      expect(isValidHarnessId(id)).toBe(false);
    }
  });

  it("accepts provider model identifiers as single argv tokens (§4.2)", () => {
    for (const id of [
      "z.ai/GLM-5.1",
      "gpt-5.4",
      "claude-opus-4-6",
      "o4-mini",
      "provider/model:latest",
      "gpt+mini",
      "A1",
      "x".repeat(128),
    ]) {
      expect(isValidModelId(id)).toBe(true);
    }
  });

  it("rejects unsafe or malformed model ids (E3)", () => {
    for (const id of [
      "", // empty
      "-model", // leading dash (option injection)
      "gpt 5.4", // whitespace (token split)
      "a;b", // metacharacters
      "a|b",
      "a&b",
      "a$b",
      "a`b`",
      "a<b",
      "a\nb",
      "a\0b", // null byte
      "x".repeat(129), // overlong
    ]) {
      expect(isValidModelId(id)).toBe(false);
    }
  });

  it("accepts well-formed model flags and rejects everything else (E5 syntax)", () => {
    expect(isValidModelFlag("--model")).toBe(true);
    expect(isValidModelFlag("--m")).toBe(true);
    expect(isValidModelFlag("--model-name-2")).toBe(true); // ^--[a-z][a-z0-9-]*$ admits digits after the first char
    expect(isValidModelFlag("-model")).toBe(false);
    expect(isValidModelFlag("--1model")).toBe(false); // first char after -- must be a-z
    expect(isValidModelFlag("model")).toBe(false);
    expect(isValidModelFlag("--model value")).toBe(false);
    expect(isValidModelFlag("--MODEL")).toBe(false);
  });

  it("freezes the harness→model-flag table (D3)", () => {
    expect(HARNESS_MODEL_FLAGS).toEqual({
      pi: "--model",
      claude: "--model",
      codex: "--model",
      copilot: "--model",
      opencode: "--model",
    });
  });
});

describe("agent-runtime harness resolution (D1)", () => {
  it("prefers agent.harness over project default and host default", () => {
    const agent = { ...baseAgent, harness: "codex" };
    const ctx = buildRuntimeResolutionContext({
      projectRuntime: { defaultHarness: "claude" },
      hostDefaultHarness: "pi",
    });
    const resolved = resolveAgentHarness(agent, ctx);
    expect(resolved).toEqual({ harness: "codex", source: "agent" });
    expect(describeHarnessResolution(expectResolved(resolved))).toContain("agent override");
  });

  it("falls back to runtime.defaultHarness (project) before the host default", () => {
    const ctx = buildRuntimeResolutionContext({
      projectRuntime: { defaultHarness: "claude" },
      hostDefaultHarness: "pi",
    });
    const resolved = resolveAgentHarness(baseAgent, ctx);
    expect(resolved).toEqual({ harness: "claude", source: "project" });
    expect(describeHarnessResolution(expectResolved(resolved))).toContain("project default");
  });

  it("falls back to the host default when nothing else is configured", () => {
    const ctx = buildRuntimeResolutionContext({ hostDefaultHarness: "pi" });
    const resolved = resolveAgentHarness(baseAgent, ctx);
    expect(resolved).toEqual({ harness: "pi", source: "host" });
    expect(describeHarnessResolution(expectResolved(resolved))).toContain("host default");
  });

  it("returns undefined when D1 is exhausted (E2 precondition)", () => {
    const ctx = buildRuntimeResolutionContext({});
    expect(resolveAgentHarness(baseAgent, ctx)).toBeUndefined();
  });

  it("hostDefaultHarnessFor maps hosts deterministically", () => {
    expect(hostDefaultHarnessFor("pi")).toBe("pi");
    expect(hostDefaultHarnessFor("herdr", "claude")).toBe("claude");
    expect(hostDefaultHarnessFor("herdr")).toBeUndefined();
    expect(hostDefaultHarnessFor("claude")).toBe("claude");
    expect(hostDefaultHarnessFor("codex")).toBe("codex");
    expect(hostDefaultHarnessFor("copilot")).toBe("copilot");
    expect(hostDefaultHarnessFor("opencode")).toBe("opencode");
    expect(hostDefaultHarnessFor("tmux")).toBeUndefined();
  });
});

describe("agent-runtime full resolution (D1+D2+D3, E1–E5)", () => {
  it("resolves harness, model and flag together for a known harness", () => {
    const agent = { ...baseAgent, harness: "codex" };
    const result = resolveAgentRuntime(agent, "gpt-5.4", buildRuntimeResolutionContext({}));
    expect(result).toEqual({
      ok: true,
      runtime: { harness: "codex", harnessSource: "agent", model: "gpt-5.4", modelFlag: "--model" },
    });
  });

  it('emits no flag when the model resolves to "default" (D3 row 3)', () => {
    const agent = { ...baseAgent, harness: "codex" };
    const result = resolveAgentRuntime(agent, "default", buildRuntimeResolutionContext({}));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.runtime.modelFlag).toBeUndefined();
  });

  it("E1: an invalid harness id is a typed failure", () => {
    const agent = { ...baseAgent, harness: "BAD ID" };
    const result = resolveAgentRuntime(agent, "gpt-5.4", buildRuntimeResolutionContext({}));
    expect(result).toMatchObject({ ok: false, code: "E_INVALID_HARNESS" });
  });

  it("E2: no resolvable harness is a typed failure", () => {
    const result = resolveAgentRuntime(baseAgent, "gpt-5.4", buildRuntimeResolutionContext({}));
    expect(result).toMatchObject({ ok: false, code: "E_NO_HARNESS" });
  });

  it("E3: an invalid model id is a typed failure", () => {
    const agent = { ...baseAgent, harness: "codex" };
    const result = resolveAgentRuntime(agent, "-evil", buildRuntimeResolutionContext({}));
    expect(result).toMatchObject({ ok: false, code: "E_INVALID_MODEL" });
  });

  it("E4: an explicit model on an untabled harness without override is a typed failure", () => {
    const agent = { ...baseAgent, harness: "grok" };
    const result = resolveAgentRuntime(agent, "grok-4", buildRuntimeResolutionContext({}));
    expect(result).toMatchObject({ ok: false, code: "E_MODEL_FLAG_UNKNOWN" });
    if (!result.ok) expect(result.message).toContain("harnessModelFlag");
  });

  it("E4 is repaired by runtime.harnessModelFlag (config override wins)", () => {
    const agent = { ...baseAgent, harness: "grok" };
    const result = resolveAgentRuntime(
      agent,
      "grok-4",
      buildRuntimeResolutionContext({ projectRuntime: { harnessModelFlag: { grok: "--model" } } }),
    );
    expect(result).toEqual({
      ok: true,
      runtime: { harness: "grok", harnessSource: "agent", model: "grok-4", modelFlag: "--model" },
    });
  });

  it("E5: a malformed flag override is a typed failure", () => {
    const agent = { ...baseAgent, harness: "grok" };
    const result = resolveAgentRuntime(
      agent,
      "grok-4",
      buildRuntimeResolutionContext({ projectRuntime: { harnessModelFlag: { grok: "model" } } }),
    );
    expect(result).toMatchObject({ ok: false, code: "E_INVALID_FLAG_OVERRIDE" });
  });

  it("I1/I4: resolution is pure and deterministic — same inputs, same outputs", () => {
    const agent = { ...baseAgent, harness: "claude" };
    const ctx = buildRuntimeResolutionContext({ hostDefaultHarness: "pi" });
    const first = resolveAgentRuntime(agent, "claude-opus-4-6", ctx);
    const second = resolveAgentRuntime(agent, "claude-opus-4-6", ctx);
    expect(first).toEqual(second);
  });
});
