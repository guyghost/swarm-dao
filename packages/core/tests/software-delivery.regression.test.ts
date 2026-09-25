import { describe, expect, it } from "bun:test";
import { createSoftwareDeliveryActor, type SoftwareDeliveryEvent } from "../src/models/software-delivery.machine.js";

const input = () => ({
  runId: "delivery-regression",
  productRunId: "product-12",
  graphRunId: "graph-12",
  proposalId: "legacy-proposal-12",
  scope: "refresh-search-index",
  scopeHash: "scope-hash-12",
  riskClass: "standard" as const,
});

const reachGraphApproval = () => {
  const actor = createSoftwareDeliveryActor(input());
  actor.send({ type: "INTAKE_ACCEPTED", source: "tool", evidence: "product:execution" });
  actor.send({ type: "GRAPH_MODEL_DRAFTED", source: "ai", evidence: "modeler:draft" });
  actor.send({
    type: "MODEL_CONTRACT_VALID",
    source: "tool",
    modelHash: "expected-model-hash",
    evidence: "validator:pass",
  });
  return actor;
};

describe("software delivery regression guards", () => {
  it("ignores events from the wrong source or with empty evidence", () => {
    const actor = createSoftwareDeliveryActor(input());
    actor.send({ type: "INTAKE_ACCEPTED", source: "ai", evidence: "product:execution" });
    expect(actor.getSnapshot().value).toBe("intake");

    actor.send({ type: "INTAKE_ACCEPTED", source: "tool", evidence: " " });
    expect(actor.getSnapshot().value).toBe("intake");
    actor.stop();
  });

  it("does not treat Product or Graph state as authority over immutable run correlation", () => {
    const actor = createSoftwareDeliveryActor(input());
    actor.send({ type: "INTAKE_ACCEPTED", source: "tool", evidence: "product:execution" });
    actor.send({ type: "GRAPH_MODEL_DRAFTED", source: "ai", evidence: "modeler:draft" });

    expect(actor.getSnapshot().context).toMatchObject({
      runId: "delivery-regression",
      productRunId: "product-12",
      graphRunId: "graph-12",
      proposalId: "legacy-proposal-12",
      scope: "refresh-search-index",
      scopeHash: "scope-hash-12",
    });
    expect("productContext" in actor.getSnapshot().context).toBe(false);
    expect("graphContext" in actor.getSnapshot().context).toBe(false);
    actor.stop();
  });

  it("requires confirmed rollback before accepting corrective-task evidence", () => {
    const actor = createSoftwareDeliveryActor(input());
    actor.send({ type: "INTAKE_ACCEPTED", source: "tool", evidence: "product:execution" });
    actor.send({ type: "GRAPH_MODEL_DRAFTED", source: "ai", evidence: "modeler:draft" });
    actor.send({
      type: "MODEL_CONTRACT_VALID",
      source: "tool",
      modelHash: "expected-model-hash",
      evidence: "validator:pass",
    });
    actor.send({
      type: "GRAPH_APPROVAL_CONFIRMED",
      source: "tool",
      modelHash: "expected-model-hash",
      evidence: "graph:ready",
    });
    actor.send({ type: "GRAPH_IMPLEMENTATION_STARTED", source: "tool", evidence: "graph:implementing" });
    actor.send({
      type: "GRAPH_IMPLEMENTATION_SUCCEEDED",
      source: "tool",
      implementationHash: "impl-hash",
      artifactHash: "artifact-hash",
      evidence: "graph:succeeded",
    });
    actor.send({ type: "PRODUCT_SHIP_READY", source: "tool", evidence: "product:ship" });
    actor.send({ type: "SHIP_CONFIRMED", source: "tool", artifactHash: "artifact-hash", evidence: "stage:active" });
    actor.send({ type: "ROLLBACK_REQUIRED", source: "tool", evidence: "product:rollback" });

    actor.send({ type: "CORRECTIVE_TASK_OPENED", source: "tool", evidence: "product:corrective" });
    expect(actor.getSnapshot().value).toBe("observing");
    actor.stop();
  });

  it("keeps terminal outcomes immutable", () => {
    const actor = reachGraphApproval();
    actor.send({ type: "GRAPH_APPROVAL_REJECTED", source: "tool", evidence: "graph:owner-rejected" });
    expect(actor.getSnapshot().value).toBe("rejected");

    const before = actor.getSnapshot().context;
    const lateEvents: SoftwareDeliveryEvent[] = [
      { type: "INTAKE_ACCEPTED", source: "tool", evidence: "late:intake" },
      { type: "GRAPH_APPROVAL_CONFIRMED", source: "tool", modelHash: "expected-model-hash", evidence: "late:approval" },
      { type: "CANCEL_REQUESTED", source: "human", evidence: "late:cancel" },
      { type: "CANCEL_SETTLED", source: "tool", evidence: "late:settled" },
    ];
    for (const event of lateEvents) actor.send(event);

    expect(actor.getSnapshot().value).toBe("rejected");
    expect(actor.getSnapshot().context).toEqual(before);
    actor.stop();
  });
});
