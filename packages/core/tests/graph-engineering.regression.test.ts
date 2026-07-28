import { describe, expect, it } from "bun:test";
import { createActor } from "xstate";
import { graphEngineeringMachine } from "../src/models/graph-engineering.machine.js";

const startActor = () => {
  const actor = createActor(graphEngineeringMachine, { input: { runId: "graph-regression" } });
  actor.start();
  return actor;
};

const reachAwaitingApproval = () => {
  const actor = startActor();
  actor.send({ type: "MODEL_DRAFTED", source: "ai", modelHash: "model-a" });
  actor.send({ type: "MODEL_CONTRACT_VALID", source: "tool", evidence: "valid" });
  return actor;
};

describe("graph engineering counter-metrics", () => {
  it("rejects wrong-source and stale-hash authority escalation", () => {
    const draftActor = startActor();
    draftActor.send({ type: "MODEL_DRAFTED", source: "human", modelHash: "model-a" });
    expect(draftActor.getSnapshot().value).toBe("draft");

    const approvalActor = reachAwaitingApproval();
    approvalActor.send({ type: "MODEL_APPROVED", source: "human", modelHash: "model-stale" });
    expect(approvalActor.getSnapshot().value).toBe("awaitingApproval");
    expect(approvalActor.getSnapshot().context.approvedModelHash).toBeNull();
  });

  it("keeps the first anchor result immutable within an attempt", () => {
    const actor = reachAwaitingApproval();
    actor.send({ type: "MODEL_APPROVED", source: "human", modelHash: "model-a" });
    actor.send({ type: "START_IMPLEMENTATION", source: "system" });
    actor.send({ type: "IMPLEMENTATION_READY", source: "ai", implementationHash: "implementation-a" });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "repository-ci",
      status: "failed",
      evidence: "CI failed",
    });
    actor.send({
      type: "ANCHOR_RECORDED",
      source: "tool",
      anchor: "repository-ci",
      status: "passed",
      evidence: "attempted overwrite",
    });

    expect(actor.getSnapshot().context.anchors["repository-ci"]?.status).toBe("failed");
  });

  it("keeps explicit terminal states immutable", () => {
    const actor = reachAwaitingApproval();
    actor.send({ type: "CANCEL", source: "human", reason: "owner cancelled" });
    actor.send({ type: "MODEL_APPROVED", source: "human", modelHash: "model-a" });
    actor.send({ type: "START_IMPLEMENTATION", source: "system" });

    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actor.getSnapshot().context.terminalReason).toBe("owner cancelled");
  });
});
