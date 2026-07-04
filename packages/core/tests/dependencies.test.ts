import { describe, expect, it } from "bun:test";
import type { Proposal } from "@guyghost/swarm-dao-core";
import { getUnexecutedDependencies, resolveDependencyOrder } from "@guyghost/swarm-dao-core";

function makeProposal(id: number, status: Proposal["status"] = "controlled", dependsOn?: number[]): Proposal {
  return {
    id,
    title: `Proposal ${id}`,
    type: "product-feature",
    description: "test",
    proposedBy: "test",
    status,
    votes: [],
    agentOutputs: [],
    createdAt: new Date().toISOString(),
    dependsOn,
  };
}

describe("resolveDependencyOrder", () => {
  it("returns single proposal with no dependencies", () => {
    const proposals = [makeProposal(1)];
    const result = resolveDependencyOrder(1, proposals);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual([1]);
  });

  it("orders linear chain: dep before target", () => {
    // 2 depends on 1, 3 depends on 2
    const proposals = [makeProposal(1), makeProposal(2, "controlled", [1]), makeProposal(3, "controlled", [2])];
    const result = resolveDependencyOrder(3, proposals);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual([1, 2, 3]);
  });

  it("handles diamond dependency: A → B, A → C, B → D, C → D", () => {
    // Ship D: depends on B and C; B depends on A; C depends on A
    const a = makeProposal(1);
    const b = makeProposal(2, "controlled", [1]);
    const c = makeProposal(3, "controlled", [1]);
    const d = makeProposal(4, "controlled", [2, 3]);
    const result = resolveDependencyOrder(4, [a, b, c, d]);
    expect(result.error).toBeUndefined();
    const order = result.order ?? [];
    // A must come before B and C; B and C before D
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(4));
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(4));
  });

  it("detects direct self-cycle", () => {
    const proposals = [makeProposal(1, "controlled", [1])];
    const result = resolveDependencyOrder(1, proposals);
    expect(result.error).toContain("Circular dependency");
  });

  it("detects indirect cycle A → B → A", () => {
    const a = makeProposal(1, "controlled", [2]);
    const b = makeProposal(2, "controlled", [1]);
    const result = resolveDependencyOrder(1, [a, b]);
    expect(result.error).toContain("Circular dependency");
  });

  it("errors on missing dependency reference", () => {
    const proposals = [makeProposal(1, "controlled", [99])];
    const result = resolveDependencyOrder(1, proposals);
    expect(result.error).toContain("#99");
    expect(result.error).toContain("not found");
  });

  it("errors on unknown target", () => {
    const result = resolveDependencyOrder(42, []);
    expect(result.error).toContain("#42");
    expect(result.error).toContain("not found");
  });
});

describe("getUnexecutedDependencies", () => {
  it("returns empty when no dependencies", () => {
    const proposals = [makeProposal(1)];
    const result = getUnexecutedDependencies(1, proposals);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual([]);
  });

  it("excludes already-executed dependencies", () => {
    const a = makeProposal(1, "executed");
    const b = makeProposal(2, "controlled", [1]);
    const result = getUnexecutedDependencies(2, [a, b]);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual([]);
  });

  it("returns unexecuted deps excluding target itself", () => {
    const a = makeProposal(1, "controlled");
    const b = makeProposal(2, "controlled", [1]);
    const result = getUnexecutedDependencies(2, [a, b]);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual([1]);
  });

  it("orders multiple unexecuted deps correctly", () => {
    const a = makeProposal(1, "controlled");
    const b = makeProposal(2, "controlled", [1]);
    const c = makeProposal(3, "controlled", [2]);
    const result = getUnexecutedDependencies(3, [a, b, c]);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual([1, 2]);
  });

  it("returns only the truly unexecuted subset in order when a mid-chain dep is executed", () => {
    // Chain: D(4) -> C(3) -> B(2) -> A(1); B is already executed.
    const a = makeProposal(1, "controlled");
    const b = makeProposal(2, "executed", [1]);
    const c = makeProposal(3, "controlled", [2]);
    const d = makeProposal(4, "controlled", [3]);
    const result = getUnexecutedDependencies(4, [a, b, c, d]);
    expect(result.error).toBeUndefined();
    // Target (4) dropped, executed B (2) dropped -> remaining unexecuted keep order A(1), C(3)
    expect(result.order).toEqual([1, 3]);
    const order = result.order ?? [];
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
  });

  it("handles diamond with one executed branch in getUnexecutedDependencies", () => {
    // D(4) -> {B(2), C(3)}; B -> A(1); C -> A(1). B is already executed.
    const a = makeProposal(1, "controlled");
    const b = makeProposal(2, "executed", [1]);
    const c = makeProposal(3, "controlled", [1]);
    const d = makeProposal(4, "controlled", [2, 3]);
    const result = getUnexecutedDependencies(4, [a, b, c, d]);
    expect(result.error).toBeUndefined();
    const order = result.order ?? [];
    // Executed B(2) dropped; A(1) and C(3) remain; A must still precede C.
    expect(order).toEqual([1, 3]);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
  });

  it("returns { error } for a cycle", () => {
    const a = makeProposal(1, "controlled", [2]);
    const b = makeProposal(2, "controlled", [1]);
    const result = getUnexecutedDependencies(1, [a, b]);
    expect(result.order).toBeUndefined();
    expect(result.error).toContain("Circular dependency");
  });

  it("returns { error } for a missing dependency reference", () => {
    const a = makeProposal(1, "controlled", [99]);
    const result = getUnexecutedDependencies(1, [a]);
    expect(result.order).toBeUndefined();
    expect(result.error).toContain("#99");
    expect(result.error).toContain("not found");
  });
});
