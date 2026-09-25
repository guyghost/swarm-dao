import { describe, expect, it } from "bun:test";
import {
  createSoftwareDeliveryActor,
  type DeliveryRiskClass,
  type SoftwareDeliveryEvent,
} from "../src/models/software-delivery.machine.js";

const input = (riskClass: DeliveryRiskClass = "standard") => ({
  runId: "delivery-1",
  productRunId: "product-7",
  graphRunId: "graph-7",
  proposalId: "proposal-7",
  scope: "optimize-query-cache",
  scopeHash: "scope-hash-1",
  riskClass,
});

type DeliveryActor = ReturnType<typeof createSoftwareDeliveryActor>;

const send = (actor: DeliveryActor, event: SoftwareDeliveryEvent) => actor.send(event);

const reachGraphApproval = (actor: DeliveryActor, modelHash = "model-hash-1") => {
  send(actor, { type: "INTAKE_ACCEPTED", source: "tool", evidence: "product-journal:8" });
  send(actor, { type: "GRAPH_MODEL_DRAFTED", source: "ai", evidence: "modeler:artifact-1" });
  send(actor, { type: "MODEL_CONTRACT_VALID", source: "tool", modelHash, evidence: "contract:passed" });
};

const reachImplementation = (actor: DeliveryActor, riskClass: DeliveryRiskClass = "standard") => {
  reachGraphApproval(actor);
  send(actor, { type: "GRAPH_APPROVAL_CONFIRMED", source: "tool", modelHash: "model-hash-1", evidence: "graph:ready" });
  send(actor, { type: "GRAPH_IMPLEMENTATION_STARTED", source: "tool", evidence: "graph:implementing" });
  send(actor, {
    type: "GRAPH_IMPLEMENTATION_SUCCEEDED",
    source: "tool",
    implementationHash: "implementation-hash-1",
    artifactHash: "artifact-hash-1",
    evidence: "graph:succeeded",
  });
  if (riskClass === "sensitive") {
    send(actor, { type: "PRODUCT_REVIEW_REQUIRED", source: "tool", evidence: "product:review-sensitive-deploy" });
  }
};

describe("software delivery machine", () => {
  it("holds unknown risk before model preparation and preserves the initial classification", () => {
    const actor = createSoftwareDeliveryActor(input("unknown"));
    send(actor, { type: "INTAKE_ACCEPTED", source: "tool", evidence: "product-journal:8" });
    expect(actor.getSnapshot().value).toBe("awaitingRiskReview");

    send(actor, {
      type: "RISK_CLASSIFICATION_RESOLVED",
      source: "ai",
      riskClass: "standard",
      evidence: "classifier:1",
    });
    expect(actor.getSnapshot().value).toBe("awaitingRiskReview");
    send(actor, {
      type: "RISK_CLASSIFICATION_RESOLVED",
      source: "human",
      riskClass: "standard",
      evidence: " ",
    });
    expect(actor.getSnapshot().value).toBe("awaitingRiskReview");
    send(actor, {
      type: "RISK_CLASSIFICATION_RESOLVED",
      source: "human",
      riskClass: "standard",
      evidence: "owner-review:1",
    });

    expect(actor.getSnapshot().value).toBe("draftingGraphModel");
    expect(actor.getSnapshot().context.initialRiskClass).toBe("unknown");
    expect(actor.getSnapshot().context.riskClass).toBe("standard");
    actor.stop();
  });

  it("does not accept approval for another Graph model hash", () => {
    const actor = createSoftwareDeliveryActor(input());
    reachGraphApproval(actor, "model-hash-1");

    send(actor, {
      type: "GRAPH_APPROVAL_CONFIRMED",
      source: "tool",
      modelHash: "model-hash-2",
      evidence: "graph:4",
    });

    expect(actor.getSnapshot().value).toBe("awaitingGraphApproval");
    expect(actor.getSnapshot().context.approvedModelHash).toBeNull();
    actor.stop();
  });

  it("waits for Product review before a sensitive change can become ship-ready", () => {
    const actor = createSoftwareDeliveryActor(input("sensitive"));
    reachImplementation(actor, "sensitive");

    expect(actor.getSnapshot().value).toBe("awaitingShipReview");
    send(actor, { type: "PRODUCT_SHIP_READY", source: "tool", evidence: "product:ship" });
    expect(actor.getSnapshot().value).toBe("awaitingShipReview");

    send(actor, { type: "PRODUCT_SHIP_AUTHORIZED", source: "tool", evidence: "product:human-review-journal:12" });
    expect(actor.getSnapshot().value).toBe("shipReady");
    actor.stop();
  });

  it("pauses for staging capability and validates only after Product observation evidence", () => {
    const actor = createSoftwareDeliveryActor(input());
    reachImplementation(actor);
    send(actor, { type: "PRODUCT_SHIP_READY", source: "tool", evidence: "product:ship" });
    send(actor, { type: "SHIP_CAPABILITY_MISSING", source: "tool", evidence: "stage:not-configured" });
    expect(actor.getSnapshot().value).toBe("awaitingShipCapability");
    send(actor, { type: "SHIP_CAPABILITY_CONFIRMED", source: "tool", evidence: "stage:rollback-verified" });
    expect(actor.getSnapshot().value).toBe("shipReady");
    send(actor, {
      type: "SHIP_CONFIRMED",
      source: "tool",
      artifactHash: "artifact-hash-1",
      evidence: "stage:active-pointer",
    });
    expect(actor.getSnapshot().value).toBe("observing");
    send(actor, { type: "OBSERVATION_SAMPLE_RECORDED", source: "tool", evidence: "stage:sample-1" });
    send(actor, {
      type: "OBSERVATION_VALIDATED",
      source: "tool",
      evidence: "product:observation-window-validated",
    });

    expect(actor.getSnapshot().value).toBe("validated");
    expect(actor.getSnapshot().context.outcome).toBe("validated");
    expect(actor.getSnapshot().context.effectCheckpoint?.name).toBe("ship");
    expect(actor.getSnapshot().context.observationEvidence).toEqual(["stage:sample-1"]);
    actor.stop();
  });

  it("records a failed model contract as a failed terminal outcome", () => {
    const actor = createSoftwareDeliveryActor(input());
    send(actor, { type: "INTAKE_ACCEPTED", source: "tool", evidence: "product-journal:8" });
    send(actor, { type: "GRAPH_MODEL_DRAFTED", source: "ai", evidence: "modeler:artifact-1" });
    send(actor, { type: "MODEL_CONTRACT_INVALID", source: "tool", evidence: "contract:invalid" });

    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.outcome).toBe("failed");
    actor.stop();
  });

  it("requires restored stage evidence and a corrective task before rollback is terminal", () => {
    const actor = createSoftwareDeliveryActor(input());
    reachImplementation(actor);
    send(actor, { type: "PRODUCT_SHIP_READY", source: "tool", evidence: "product:ship" });
    send(actor, {
      type: "SHIP_CONFIRMED",
      source: "tool",
      artifactHash: "artifact-hash-1",
      evidence: "stage:active-pointer",
    });
    send(actor, { type: "ROLLBACK_REQUIRED", source: "tool", evidence: "product:rollback:1" });
    send(actor, { type: "ROLLBACK_CONFIRMED", source: "tool", evidence: "stage:restored" });

    send(actor, { type: "CORRECTIVE_TASK_OPENED", source: "tool", evidence: " " });
    expect(actor.getSnapshot().value).toBe("observing");
    send(actor, {
      type: "CORRECTIVE_TASK_OPENED",
      source: "tool",
      evidence: "product:corrective-proposition:2",
    });
    expect(actor.getSnapshot().value).toBe("rolledBack");
    expect(actor.getSnapshot().context.outcome).toBe("rolledBack");
    actor.stop();
  });

  it("does not accept tool cancellation and waits for reconciliation after a human request", () => {
    const actor = createSoftwareDeliveryActor(input());
    send(actor, { type: "INTAKE_ACCEPTED", source: "tool", evidence: "product-journal:8" });

    send(actor, { type: "CANCEL_REQUESTED", source: "tool", evidence: "forged-cancel" });
    expect(actor.getSnapshot().value).toBe("draftingGraphModel");
    expect(actor.getSnapshot().context.cancellationRequested).toBe(false);

    send(actor, { type: "CANCEL_REQUESTED", source: "human", evidence: "owner:cancel-request:1" });
    expect(actor.getSnapshot().value).toBe("draftingGraphModel");
    expect(actor.getSnapshot().context.cancellationRequested).toBe(true);
    send(actor, { type: "CANCEL_SETTLED", source: "tool", evidence: "executor:children-reconciled" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    actor.stop();
  });
});
