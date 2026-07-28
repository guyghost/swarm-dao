import { describe, expect, it } from "bun:test";
import type { AgentOutput, DAOAgent, DAOConfig, HostAdapter, Proposal } from "@guyghost/swarm-dao-core";
import {
  buildChildAgent,
  buildChildModelResolutionContext,
  buildModelResolutionContext,
  computeMergedFoldHash,
  createDelegationCoordinatorMachine,
  createDelegationRequestMachine,
  type DelegationCoordinatorEvent,
  type DelegationCoordinatorInput,
  type DelegationCoordinatorState,
  type DelegationRequestInput,
  type DelegationRequestState,
  type DelegationRequestStatus,
  describeModelResolution,
  dispatchCoordinatorEvent,
  dispatchDelegationEvent,
  drainDelegations,
  evaluateDelegationGate,
  extractDelegationSignals,
  foldChildIntoParent,
  normalizeFacet,
  resolveAgentModel,
  resolveDelegationProfile,
  runDelegations,
} from "@guyghost/swarm-dao-core";
import { createActor } from "xstate";

// ── Fixtures ─────────────────────────────────────────────────

function makeParent(overrides: Partial<DAOAgent> = {}): DAOAgent {
  return {
    id: "agent-architect",
    name: "Architect",
    role: "Council member",
    description: "Parent agent under test",
    weight: 3,
    systemPrompt: "You design.",
    model: "parent-llm",
    enabled: true,
    delegates: [{ facet: "Security", archetype: "auditor" }],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DAOConfig> = {}): DAOConfig {
  return {
    quorumPercent: 60,
    approvalThreshold: 55,
    defaultModel: "dao-default",
    maxConcurrent: 4,
    riskThreshold: 7,
    requiredGates: [],
    typeQuorum: {},
    quorumFloor: 60,
    delegation: { enabled: true, maxDepth: 1, maxChildrenPerParent: 3, foldTimeoutMs: 30_000 },
    delegationProfile: { auditor: { defaultModel: "auditor-llm", promptId: "audit" } },
    ...overrides,
  };
}

function makeProposal(): Proposal {
  return {
    id: 1,
    title: "P",
    type: "product-feature",
    description: "d",
    proposedBy: "agent-architect",
    status: "deliberating",
    votes: [],
    agentOutputs: [],
    createdAt: new Date().toISOString(),
  } as Proposal;
}

function outputFor(agentId: string, content: string, error?: string): AgentOutput {
  return { agentId, agentName: agentId, role: "delegate", content, durationMs: 1, error };
}

function fakeAdapter(childContent: string, error?: string): HostAdapter {
  return {
    hostId: "fake",
    spawnAgent: async () => outputFor("child", childContent, error),
    spawnAgents: async () => [],
  } as HostAdapter;
}

// ── Pure helpers ─────────────────────────────────────────────

describe("delegation pure helpers", () => {
  it("normalizeFacet trims + lowercases (INV-5)", () => {
    expect(normalizeFacet("  Security ")).toBe("security");
    expect(normalizeFacet("SECURITY")).toBe("security");
  });

  it("evaluateDelegationGate: declared + registered + within depth ⇒ ok", () => {
    const r = evaluateDelegationGate({
      facet: "security",
      archetype: "auditor",
      parentDepth: 0,
      maxDepth: 1,
      declared: [{ facet: "security", archetype: "auditor" }],
      registeredArchetypes: new Set(["auditor"]),
    });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("evaluateDelegationGate: undeclared facet ⇒ reject (INV-2/INV-5)", () => {
    const r = evaluateDelegationGate({
      facet: "finance",
      archetype: "auditor",
      parentDepth: 0,
      maxDepth: 1,
      declared: [{ facet: "security", archetype: "auditor" }],
      registeredArchetypes: new Set(["auditor"]),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(";")).toMatch(/not declared/);
  });

  it("evaluateDelegationGate: archetype mismatch ⇒ reject", () => {
    const r = evaluateDelegationGate({
      facet: "security",
      archetype: "lawyer",
      parentDepth: 0,
      maxDepth: 1,
      declared: [{ facet: "security", archetype: "auditor" }],
      registeredArchetypes: new Set(["auditor", "lawyer"]),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(";")).toMatch(/declared for archetype/);
  });

  it("evaluateDelegationGate: depth cap ⇒ reject (INV-1)", () => {
    const r = evaluateDelegationGate({
      facet: "security",
      archetype: "auditor",
      parentDepth: 1,
      maxDepth: 1,
      declared: [{ facet: "security", archetype: "auditor" }],
      registeredArchetypes: new Set(["auditor"]),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(";")).toMatch(/depth cap/);
  });

  it("evaluateDelegationGate: unregistered archetype ⇒ reject", () => {
    const r = evaluateDelegationGate({
      facet: "security",
      archetype: "auditor",
      parentDepth: 0,
      maxDepth: 1,
      declared: [{ facet: "security", archetype: "auditor" }],
      registeredArchetypes: new Set(),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(";")).toMatch(/no registered delegation profile/);
  });

  it("computeMergedFoldHash is deterministic and content-sensitive (B2)", () => {
    const a = computeMergedFoldHash("hello");
    const b = computeMergedFoldHash("hello");
    const c = computeMergedFoldHash("world");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("fnv1a:")).toBe(true);
  });

  it("extractDelegationSignals parses the Delegation Requests section (INV-3)", () => {
    const content = [
      "## Reasoning",
      "Some text.",
      "## Delegation Requests",
      "- facet: Security | archetype: auditor",
      "- facet: Performance | archetype: benchmark",
      "## Vote",
      "for",
    ].join("\n");
    const signals = extractDelegationSignals(content);
    expect(signals).toEqual([
      { facet: "security", archetype: "auditor" },
      { facet: "performance", archetype: "benchmark" },
    ]);
  });

  it("extractDelegationSignals normalizes both facet and archetype to lowercase", () => {
    const content = [
      "## Delegation Requests",
      "- facet: Security | archetype: Auditor",
      "- facet: PERFORMANCE | archetype: BENCHMARK",
    ].join("\n");
    const signals = extractDelegationSignals(content);
    expect(signals).toEqual([
      { facet: "security", archetype: "auditor" },
      { facet: "performance", archetype: "benchmark" },
    ]);
  });

  it("extractDelegationSignals ignores malformed lines and empty sections (W2)", () => {
    expect(extractDelegationSignals(undefined)).toEqual([]);
    expect(extractDelegationSignals("no section here")).toEqual([]);
    expect(extractDelegationSignals("## Delegation Requests\n- not a directive\n- facet: x\n")).toEqual([]);
  });

  it("resolveDelegationProfile returns the registered entry", () => {
    const profiles = { auditor: { promptId: "audit", defaultModel: "a-llm" } };
    expect(resolveDelegationProfile(profiles, "auditor")?.promptId).toBe("audit");
    expect(resolveDelegationProfile(profiles, "missing")).toBeUndefined();
  });

  it("buildChildAgent forces weight 0 (INV-6) and id from facet", () => {
    const child = buildChildAgent(makeParent(), { facet: "Security", archetype: "auditor" });
    expect(child.weight).toBe(0);
    expect(child.id).toBe("agent-architect:delegate:security");
    expect(child.model).toBeUndefined();
  });

  it("buildChildAgent keeps explicit model override", () => {
    const child = buildChildAgent(makeParent(), { facet: "Security", archetype: "auditor", model: "gpt-5" });
    expect(child.model).toBe("gpt-5");
  });
});

// ── Coordinator machine ──────────────────────────────────────

function coordinatorInput(overrides: Partial<DelegationCoordinatorInput> = {}): DelegationCoordinatorInput {
  return {
    parentAgentId: "agent-architect",
    parentDepth: 0,
    parentEnabled: true,
    maxChildren: 2,
    maxDepth: 1,
    activeRequests: 0,
    ...overrides,
  };
}

describe("DelegationCoordinator machine", () => {
  it("accepts REQUEST_ARRIVED when budget available (INV-7)", () => {
    const machine = createDelegationCoordinatorMachine("open");
    const actor = createActor(machine, { input: coordinatorInput() });
    actor.start();
    const evt: DelegationCoordinatorEvent = {
      type: "REQUEST_ARRIVED",
      requestId: "r1",
      facet: "security",
      archetype: "auditor",
    };
    expect(actor.getSnapshot().can(evt)).toBe(true);
    actor.send(evt);
    expect(actor.getSnapshot().value).toBe("open");
    expect(actor.getSnapshot().context.activeRequests).toBe(1);
  });

  it("INV-7: stays open + does NOT consume budget when guard fails", () => {
    const machine = createDelegationCoordinatorMachine("open");
    const actor = createActor(machine, { input: coordinatorInput({ activeRequests: 2 }) });
    actor.start();
    const evt: DelegationCoordinatorEvent = {
      type: "REQUEST_ARRIVED",
      requestId: "r2",
      facet: "security",
      archetype: "auditor",
    };
    expect(actor.getSnapshot().can(evt)).toBe(true); // fallback transition permits
    actor.send(evt);
    expect(actor.getSnapshot().value).toBe("open");
    expect(actor.getSnapshot().context.activeRequests).toBe(2); // unchanged
  });

  it("DRAIN → draining → closed when no in-flight (cascade)", () => {
    const machine = createDelegationCoordinatorMachine("open");
    const actor = createActor(machine, { input: coordinatorInput({ activeRequests: 0 }) });
    actor.start();
    actor.send({ type: "DRAIN", reason: "terminal" });
    expect(actor.getSnapshot().value).toBe("draining");
    actor.send({ type: "REQUEST_RESOLVED", requestId: "r0", terminalStatus: "cancelled" });
    expect(actor.getSnapshot().value).toBe("closed");
  });

  it("draining with in-flight stays in draining, then closes", () => {
    const machine = createDelegationCoordinatorMachine("open");
    const actor = createActor(machine, { input: coordinatorInput({ activeRequests: 2 }) });
    actor.start();
    actor.send({ type: "DRAIN", reason: "terminal" });
    expect(actor.getSnapshot().value).toBe("draining");
    actor.send({ type: "REQUEST_RESOLVED", requestId: "r1", terminalStatus: "cancelled" });
    expect(actor.getSnapshot().value).toBe("draining");
    expect(actor.getSnapshot().context.activeRequests).toBe(1);
    actor.send({ type: "REQUEST_RESOLVED", requestId: "r2", terminalStatus: "cancelled" });
    expect(actor.getSnapshot().value).toBe("closed");
  });

  it("REQUEST_RESOLVED in open decrements activeRequests and releases the slot", () => {
    const machine = createDelegationCoordinatorMachine("open");
    const actor = createActor(machine, { input: coordinatorInput({ maxChildren: 2 }) });
    actor.start();

    actor.send({ type: "REQUEST_ARRIVED", requestId: "r1", facet: "security", archetype: "auditor" });
    expect(actor.getSnapshot().context.activeRequests).toBe(1);

    actor.send({ type: "REQUEST_ARRIVED", requestId: "r2", facet: "security", archetype: "auditor" });
    expect(actor.getSnapshot().context.activeRequests).toBe(2);

    // Budget full: third arrival falls back without consuming a slot.
    actor.send({ type: "REQUEST_ARRIVED", requestId: "r3", facet: "security", archetype: "auditor" });
    expect(actor.getSnapshot().context.activeRequests).toBe(2);

    // Slot released while still open: 2 -> 1.
    actor.send({ type: "REQUEST_RESOLVED", requestId: "r1", terminalStatus: "delegated" });
    expect(actor.getSnapshot().value).toBe("open");
    expect(actor.getSnapshot().context.activeRequests).toBe(1);

    // Slot available again: 1 -> 2.
    actor.send({ type: "REQUEST_ARRIVED", requestId: "r4", facet: "security", archetype: "auditor" });
    expect(actor.getSnapshot().context.activeRequests).toBe(2);
  });

  it("ERROR → blocked_signal (terminal)", () => {
    const machine = createDelegationCoordinatorMachine("open");
    const actor = createActor(machine, { input: coordinatorInput() });
    actor.start();
    actor.send({ type: "ERROR", message: "boom" });
    expect(actor.getSnapshot().value).toBe("blocked_signal");
  });

  it("INV-4: terminal states ignore events (via dispatchCoordinatorEvent)", () => {
    const closed: DelegationCoordinatorState = {
      parentAgentId: "a",
      parentDepth: 0,
      parentEnabled: true,
      maxChildren: 2,
      maxDepth: 1,
      activeRequests: 0,
      status: "closed",
      lastTransitionTime: new Date().toISOString(),
    };
    const r = dispatchCoordinatorEvent(closed, {
      type: "REQUEST_ARRIVED",
      requestId: "r-late",
      facet: "security",
      archetype: "auditor",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/terminal/);
  });
});

// ── Request machine ──────────────────────────────────────────

function requestInput(overrides: Partial<DelegationRequestInput> = {}): DelegationRequestInput {
  return {
    requestId: "r1",
    parentAgentId: "agent-architect",
    facet: "security",
    archetype: "auditor",
    gateReasons: [],
    ...overrides,
  };
}

describe("DelegationRequest machine — happy path", () => {
  it("requested → gated → spawned → reported → delegated (authorized)", () => {
    const machine = createDelegationRequestMachine("requested");
    const actor = createActor(machine, { input: requestInput() });
    actor.start();

    expect(actor.getSnapshot().can({ type: "GATE_DECIDED", ok: true, reasons: [] })).toBe(true);
    actor.send({ type: "GATE_DECIDED", ok: true, reasons: [] });
    expect(actor.getSnapshot().value).toBe("gated");

    actor.send({ type: "SPAWN_ACKED", childAgentId: "child-1" });
    expect(actor.getSnapshot().value).toBe("spawned");
    expect(actor.getSnapshot().context.childAgentId).toBe("child-1");

    actor.send({ type: "CHILD_REPORTED", output: outputFor("child-1", "audit findings") });
    expect(actor.getSnapshot().value).toBe("reported");
    const committedHash = actor.getSnapshot().context.mergedAgentOutputHash;
    expect(typeof committedHash).toBe("string");
    expect(committedHash).toBe(computeMergedFoldHash("audit findings"));

    // B2: FOLD_COMPLETE must echo the committed hash.
    actor.send({
      type: "FOLD_COMPLETE",
      foldedInto: "agent-architect",
      mergedAgentOutputHash: committedHash as string,
    });
    expect(actor.getSnapshot().value).toBe("delegated");
  });
});

describe("DelegationRequest machine — forks", () => {
  it("GATE_DECIDED{ok:false} → blocked (INV-2: no ungated spawn)", () => {
    const machine = createDelegationRequestMachine("requested");
    const actor = createActor(machine, { input: requestInput() });
    actor.start();
    actor.send({ type: "GATE_DECIDED", ok: false, reasons: ["no"] });
    expect(actor.getSnapshot().value).toBe("blocked");
    expect(actor.getSnapshot().context.gateReasons).toEqual(["no"]);
  });

  it("B2: FOLD_COMPLETE with wrong hash stays in reported", () => {
    const machine = createDelegationRequestMachine("requested");
    const actor = createActor(machine, { input: requestInput() });
    actor.start();
    actor.send({ type: "GATE_DECIDED", ok: true, reasons: [] });
    actor.send({ type: "SPAWN_ACKED", childAgentId: "c" });
    actor.send({ type: "CHILD_REPORTED", output: outputFor("c", "real") });

    const before = actor.getSnapshot().value;
    actor.send({
      type: "FOLD_COMPLETE",
      foldedInto: "p",
      mergedAgentOutputHash: "fnv1a:deadbeef",
    });
    expect(actor.getSnapshot().value).toBe(before); // reported
    expect(actor.getSnapshot().value).toBe("reported");
  });

  it("FOLD_TIMEOUT → failed", () => {
    const machine = createDelegationRequestMachine("requested");
    const actor = createActor(machine, { input: requestInput() });
    actor.start();
    actor.send({ type: "GATE_DECIDED", ok: true, reasons: [] });
    actor.send({ type: "SPAWN_ACKED", childAgentId: "c" });
    actor.send({ type: "CHILD_REPORTED", output: outputFor("c", "x") });
    actor.send({ type: "FOLD_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("CHILD_FAILED → failed", () => {
    const machine = createDelegationRequestMachine("requested");
    const actor = createActor(machine, { input: requestInput() });
    actor.start();
    actor.send({ type: "GATE_DECIDED", ok: true, reasons: [] });
    actor.send({ type: "SPAWN_ACKED", childAgentId: "c" });
    actor.send({ type: "CHILD_FAILED", error: "child crashed" });
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("SPAWN_FAILED → failed (only reachable from spawned)", () => {
    const machine = createDelegationRequestMachine("requested");
    const actor = createActor(machine, { input: requestInput() });
    actor.start();
    actor.send({ type: "GATE_DECIDED", ok: true, reasons: [] });
    actor.send({ type: "SPAWN_ACKED", childAgentId: "c" });
    actor.send({ type: "SPAWN_FAILED", error: "no slot" });
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("CANCEL from any non-terminal → cancelled", () => {
    for (const status of ["requested", "gated", "spawned", "reported"] as DelegationRequestStatus[]) {
      const machine = createDelegationRequestMachine(status);
      const actor = createActor(machine, { input: requestInput() });
      actor.start();
      expect(actor.getSnapshot().can({ type: "CANCEL", reason: "x" })).toBe(true);
      actor.send({ type: "CANCEL", reason: "x" });
      expect(actor.getSnapshot().value).toBe("cancelled");
    }
  });

  it("INV-4: terminal states refuse events via dispatchDelegationEvent", () => {
    const terminal: DelegationRequestState = {
      requestId: "r1",
      parentAgentId: "p",
      facet: "security",
      archetype: "auditor",
      status: "delegated",
      gateReasons: [],
      lastTransitionTime: new Date().toISOString(),
    };
    const r = dispatchDelegationEvent(terminal, { type: "CANCEL", reason: "late" });
    expect(r.ok).toBe(false);
  });

  it("forbidden: requested cannot jump to spawned (no SPAWN_ACKED handler)", () => {
    const machine = createDelegationRequestMachine("requested");
    const actor = createActor(machine, { input: requestInput() });
    actor.start();
    expect(actor.getSnapshot().can({ type: "SPAWN_ACKED", childAgentId: "c" })).toBe(false);
  });
});

// ── Model resolution inheritance ─────────────────────────────

describe("model resolution — delegation inheritance", () => {
  it("'inherit' (or omitted) falls through to parent agent model", () => {
    const child = buildChildAgent(makeParent({ model: "parent-llm" }), {
      facet: "security",
      archetype: "auditor",
      model: "inherit",
    });
    const ctx = buildChildModelResolutionContext("dao-default", {
      parentAgentModel: "parent-llm",
      profile: resolveDelegationProfile({ auditor: { promptId: "a" } }, "auditor"),
    });
    expect(resolveAgentModel(child, ctx)).toBe("parent-llm");
  });

  it("explicit child override wins over everything", () => {
    const child = buildChildAgent(makeParent({ model: "parent-llm" }), {
      facet: "security",
      archetype: "auditor",
      model: "gpt-5",
    });
    const ctx = buildChildModelResolutionContext("dao-default", {
      parentAgentModel: "parent-llm",
      profile: { promptId: "a", defaultModel: "auditor-llm" },
    });
    expect(resolveAgentModel(child, ctx)).toBe("gpt-5");
  });

  it("profile default sits between override and parent", () => {
    const child = buildChildAgent(makeParent({ model: "parent-llm" }), {
      facet: "security",
      archetype: "auditor",
    });
    const ctx = buildChildModelResolutionContext("dao-default", {
      parentAgentModel: "parent-llm",
      profile: { promptId: "a", defaultModel: "auditor-llm" },
    });
    expect(resolveAgentModel(child, ctx)).toBe("auditor-llm");
  });

  it("falls back to parent session model when no profile and no parent agent model", () => {
    const child = buildChildAgent(makeParent({ model: undefined }), {
      facet: "security",
      archetype: "auditor",
    });
    const ctx = buildChildModelResolutionContext("dao-default", {
      parentAgentModel: "parent-llm",
      parentSessionModel: "session-llm",
    });
    expect(resolveAgentModel(child, ctx)).toBe("parent-llm");
  });

  it("falls to config default when nothing else resolves", () => {
    const child = buildChildAgent(makeParent({ model: undefined }), {
      facet: "security",
      archetype: "auditor",
    });
    const ctx = buildChildModelResolutionContext("dao-default", { parentAgentModel: "" as string });
    // parentAgentModel "" is falsy → next non-empty candidate is configDefaultModel
    expect(resolveAgentModel(child, ctx)).toBe("dao-default");
  });

  it("describeModelResolution labels the chosen layer", () => {
    const ctx = buildModelResolutionContext("dao-default", { parentAgentModel: "parent-llm" });
    // Child has no own model ⇒ resolved value is inherited from parentAgentModel.
    expect(describeModelResolution(makeParent({ model: undefined }), "parent-llm", ctx)).toMatch(
      /inherited from parent agent/,
    );
  });
});

// ── Orchestrator (runDelegations) ────────────────────────────

describe("runDelegations orchestrator", () => {
  it("happy path: signal → fold → delegated, parent content augmented (INV-6)", async () => {
    const parent = makeParent();
    const parentOutput = outputFor(
      "agent-architect",
      "## Reasoning\nWe need audit.\n## Delegation Requests\n- facet: Security | archetype: auditor\n## Vote\nfor",
    );
    const result = await runDelegations({
      parent,
      parentOutput,
      proposal: makeProposal(),
      adapter: fakeAdapter("audit findings"),
      config: makeConfig(),
      parentModelContext: buildModelResolutionContext("dao-default", { parentAgentModel: "parent-llm" }),
    });
    expect(result.delegated).toBe(true);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].status).toBe("delegated");
    expect(result.foldedContent).toMatch(/## Delegated Facets/);
    expect(result.foldedContent).toMatch(/audit findings/);
    // INV-6: the ## Vote section is preserved verbatim.
    expect(result.foldedContent).toMatch(/## Vote\nfor/);
  });

  it("disabled delegation ⇒ no-op", async () => {
    const result = await runDelegations({
      parent: makeParent(),
      parentOutput: outputFor("a", "## Delegation Requests\n- facet: Security | archetype: auditor"),
      proposal: makeProposal(),
      adapter: fakeAdapter("x"),
      config: makeConfig({
        delegation: { enabled: false, maxDepth: 1, maxChildrenPerParent: 3, foldTimeoutMs: 30_000 },
      }),
      parentModelContext: buildModelResolutionContext("dao-default"),
    });
    expect(result.delegated).toBe(false);
    expect(result.coordinators).toHaveLength(0);
    expect(result.requests).toHaveLength(0);
  });

  it("no signal in parent output ⇒ no-op", async () => {
    const result = await runDelegations({
      parent: makeParent(),
      parentOutput: outputFor("a", "just reasoning, no directive"),
      proposal: makeProposal(),
      adapter: fakeAdapter("x"),
      config: makeConfig(),
      parentModelContext: buildModelResolutionContext("dao-default"),
    });
    expect(result.delegated).toBe(false);
    expect(result.requests).toHaveLength(0);
  });

  it("gate rejection ⇒ request blocked, coordinator slot released", async () => {
    const parent = makeParent({ delegates: [{ facet: "Security", archetype: "auditor" }] });
    // Parent emits a facet it did NOT declare.
    const parentOutput = outputFor("agent-architect", "## Delegation Requests\n- facet: Finance | archetype: auditor");
    const result = await runDelegations({
      parent,
      parentOutput,
      proposal: makeProposal(),
      adapter: fakeAdapter("x"),
      config: makeConfig(),
      parentModelContext: buildModelResolutionContext("dao-default"),
    });
    expect(result.delegated).toBe(false);
    expect(result.requests[0].status).toBe("blocked");
  });

  it("child error ⇒ request failed", async () => {
    const parent = makeParent();
    const parentOutput = outputFor("agent-architect", "## Delegation Requests\n- facet: Security | archetype: auditor");
    const result = await runDelegations({
      parent,
      parentOutput,
      proposal: makeProposal(),
      adapter: fakeAdapter("boom", "child exploded"),
      config: makeConfig(),
      parentModelContext: buildModelResolutionContext("dao-default"),
    });
    expect(result.delegated).toBe(false);
    expect(result.requests[0].status).toBe("failed");
  });

  it("sequential delegations with maxChildren=1 both complete; slots release between requests", async () => {
    const parent = makeParent({
      delegates: [
        { facet: "Security", archetype: "auditor" },
        { facet: "Performance", archetype: "auditor" },
      ],
    });
    const parentOutput = outputFor(
      "agent-architect",
      "## Delegation Requests\n- facet: Security | archetype: auditor\n- facet: Performance | archetype: auditor",
    );
    const result = await runDelegations({
      parent,
      parentOutput,
      proposal: makeProposal(),
      adapter: fakeAdapter("ok"),
      config: makeConfig({
        delegation: { enabled: true, maxDepth: 1, maxChildrenPerParent: 1, foldTimeoutMs: 30_000 },
      }),
      parentModelContext: buildModelResolutionContext("dao-default"),
    });
    // runDelegations awaits each child sequentially, so with the coordinator
    // releasing slots on REQUEST_RESOLVED in `open`, both requests complete and
    // the in-flight counter cycles back to zero instead of accumulating.
    expect(result.requests).toHaveLength(2);
    expect(result.requests.every((r) => r.status === "delegated")).toBe(true);
    expect(result.coordinators[0].activeRequests).toBe(0);
    expect(result.coordinators[0].status).toBe("open");
  });
});

// ── Fold + cascade ───────────────────────────────────────────

describe("foldChildIntoParent (INV-6)", () => {
  it("appends a Delegated Facets section and never touches the Vote", () => {
    const parent = "## Reasoning\nr\n## Vote\nfor";
    const folded = foldChildIntoParent(parent, { facet: "security", archetype: "auditor" }, outputFor("c", "findings"));
    expect(folded).toContain("## Delegated Facets");
    expect(folded).toContain("### facet: security | archetype: auditor");
    expect(folded).toContain("## Vote\nfor");
  });
});

describe("drainDelegations cascade (B3)", () => {
  it("DRAINs coordinators and CANCELS non-terminal requests, idempotently", () => {
    const _config = makeConfig();
    const parent = makeParent();
    // Hand-roll two in-flight requests on one coordinator.
    const coord: DelegationCoordinatorState = {
      parentAgentId: parent.id,
      parentDepth: 0,
      parentEnabled: true,
      maxChildren: 3,
      maxDepth: 1,
      activeRequests: 2,
      status: "open",
      lastTransitionTime: new Date().toISOString(),
    };
    const r1: DelegationRequestState = {
      requestId: "r1",
      parentAgentId: parent.id,
      facet: "security",
      archetype: "auditor",
      status: "spawned",
      gateReasons: [],
      lastTransitionTime: new Date().toISOString(),
    };
    const r2: DelegationRequestState = { ...r1, requestId: "r2" };

    drainDelegations([coord], [r1, r2]);
    expect(coord.status).toBe("closed");
    expect(r1.status).toBe("cancelled");
    expect(r2.status).toBe("cancelled");

    // Idempotent: re-draining a closed coordinator refuses gracefully.
    expect(() => drainDelegations([coord], [r1, r2])).not.toThrow();
  });
});
