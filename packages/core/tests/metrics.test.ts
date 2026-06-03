import { beforeEach, describe, expect, it } from "bun:test";
import { createCounter, getCounter, recordProposalCreated, resetMetrics } from "../src/observability/metrics.js";

describe("observability/metrics.ts", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("creates and updates counters", () => {
    createCounter("custom_counter", "Test");
    recordProposalCreated("product-feature");
    expect(getCounter("custom_counter")).toBeDefined();
    expect(getCounter("dao_proposals_created")?.getCount()).toBe(1);
  });
});
