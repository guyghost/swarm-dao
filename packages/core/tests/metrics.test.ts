import { beforeEach, describe, expect, it } from "bun:test";
import {
  createCounter,
  createGauge,
  createHistogram,
  getCounter,
  recordProposalCreated,
  resetMetrics,
} from "../src/observability/metrics.js";

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

  it("aggregates counts in O(cardinality) without unbounded growth", () => {
    const counter = createCounter("bounded_counter", "Test");
    // 5 000 observations spread across 2 distinct label-sets.
    for (let i = 0; i < 5000; i++) {
      counter.increment({ type: i < 2500 ? "a" : "b" });
    }
    // Exact grand total is preserved.
    expect(counter.getCount()).toBe(5000);
    // Partial-label matching is preserved (O(cardinality) scan over aggregates).
    expect(counter.getCount({ type: "a" })).toBe(2500);
    expect(counter.getCount({ type: "b" })).toBe(2500);
    // The public `values` sample is bounded (not 5 000 entries).
    expect(counter.values.length).toBeLessThanOrEqual(128);

    // Multi-label partial matching across distinct label-sets.
    const multi = createCounter("multi_label_counter", "Test");
    multi.increment({ type: "a", agent: "x" });
    multi.increment({ type: "a", agent: "y" });
    multi.increment({ type: "b", agent: "x" });
    expect(multi.getCount({ type: "a" })).toBe(2);
    expect(multi.getCount({ agent: "x" })).toBe(2);
    expect(multi.getCount({ type: "b", agent: "x" })).toBe(1);
  });

  it("gauges keep last-write-wins semantics across label-sets", () => {
    const gauge = createGauge("bounded_gauge", "Test");
    gauge.set(1, { region: "eu" });
    gauge.set(2, { region: "us" });
    gauge.set(99, { region: "eu" }); // overwrite eu
    expect(gauge.getValue({ region: "eu" })).toBe(99);
    expect(gauge.getValue({ region: "us" })).toBe(2);
    expect(gauge.getValue()).toBe(99); // most recent overall
  });

  it("histograms track exact count, sum and cumulative buckets", () => {
    const histogram = createHistogram("bounded_histogram", "Test", [10, 100]);
    const samples = [5, 15, 95, 105, 50];
    for (const s of samples) histogram.observe(s, { kind: "t" });

    expect(histogram.getCount({ kind: "t" })).toBe(5);
    expect(histogram.getSum({ kind: "t" })).toBe(samples.reduce((a, b) => a + b, 0));

    const buckets = histogram.getBucketCounts({ kind: "t" });
    // Cumulative: le_10 = {5}, le_100 = {5,15,95,50} = 4, +Inf = 5.
    expect(buckets.le_10).toBe(1);
    expect(buckets.le_100).toBe(4);
    expect(buckets["+Inf"]).toBe(5);
  });

  it("reset clears aggregated state", () => {
    const counter = createCounter("reset_counter", "Test");
    counter.increment({ type: "a" });
    counter.increment({ type: "a" });
    expect(counter.getCount()).toBe(2);
    resetMetrics();
    const fresh = getCounter("reset_counter");
    expect(fresh?.getCount()).toBe(0);
    // Counter recreated by createCounter name collision: getCounter returns same instance, cleared.
    expect(fresh?.values.length).toBe(0);
  });
});
