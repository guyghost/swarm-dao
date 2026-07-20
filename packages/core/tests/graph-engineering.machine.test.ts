import { describe, expect, it } from "bun:test";
import { createActor } from "xstate";
import { graphEngineeringMachine, REQUIRED_GRAPH_ANCHORS } from "../src/models/graph-engineering.machine.js";

const startActor = (runId = "graph-machine-test") => {
  const actor = createActor(graphEngineeringMachine, { input: { runId } });
  actor.start();
  return actor;
};

const reachAwaitingApproval = () => {
  const actor = startActor();
  actor.send({ type: "MODEL_DRAFTED", source: "ai", modelHash: "model-a" });
  actor.send({
    type: "MODEL_CONTRACT_VALID",
    source: "tool",
    evidence: "model contract validated",
  });
  return actor;
};

const reachVerifying = () => {
  const actor = reachAwaitingApproval();
  actor.send({ type: "MODEL_APPROVED", source: "human", modelHash: "model-a" });
  actor.send({ type: "START_IMPLEMENTATION", source: "system" });
  actor.send({
    type: "IMPLEMENTATION_READY",
    source: "ai",
    implementationHash: "implementation-a",
  });
  return actor;
};

const passImplementationAnchors = (actor: ReturnType<typeof startActor>) => {
  for (const anchor of REQUIRED_GRAPH_ANCHORS.filter((name) => name !== "model-contract")) {
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor,
      status: "passed",
      evidence: `${anchor} exited 0`,
    });
  }
};

describe("graph engineering machine", () => {
  it("completes the nominal path only after exact-hash approval and every anchor", () => {
    const actor = reachVerifying();

    passImplementationAnchors(actor);
    actor.send({ type: "EVALUATE", source: "system" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("succeeded");
    expect(snapshot.context.approvedModelHash).toBe("model-a");
    expect(Object.keys(snapshot.context.anchors).sort()).toEqual([...REQUIRED_GRAPH_ANCHORS].sort());
  });

  it("fails closed into retrying when an anchor is missing", () => {
    const actor = reachVerifying();

    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "graph-tests",
      status: "passed",
      evidence: "targeted tests exited 0",
    });
    actor.send({ type: "EVALUATE", source: "system" });

    expect(actor.getSnapshot().value).toBe("retrying");
  });

  it("retains model approval but clears attempt evidence after an authorized retry", () => {
    const actor = reachVerifying();
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "graph-tests",
      status: "failed",
      evidence: "one graph test failed",
    });
    actor.send({ type: "EVALUATE", source: "system" });
    actor.send({ type: "RETRY_AUTHORIZED", source: "human" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("implementing");
    expect(snapshot.context.attempt).toBe(1);
    expect(snapshot.context.modelHash).toBe("model-a");
    expect(snapshot.context.approvedModelHash).toBe("model-a");
    expect(snapshot.context.implementationHash).toBeNull();
    expect(Object.keys(snapshot.context.anchors)).toEqual(["model-contract"]);
  });

  it("ends explicitly when permission is denied", () => {
    const actor = reachAwaitingApproval();

    actor.send({ type: "PERMISSION_DENIED", source: "tool", reason: "repository write denied" });

    expect(actor.getSnapshot().value).toBe("blocked");
    expect(actor.getSnapshot().context.terminalReason).toBe("repository write denied");
  });
});
