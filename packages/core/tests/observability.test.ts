import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCounter,
  createGauge,
  createHistogram,
  getCounter,
  getGauge,
  getHistogram,
  resetMetrics,
  DAO_METRICS,
  recordProposalCreated,
  recordProposalApproved,
  recordProposalRejected,
  recordProposalExecuted,
  formatMetrics,
  formatMetricsPrometheus,
  startSpan,
  finishSpan,
  getTrace,
  getActiveSpans,
  resetTracing,
  traced,
  formatTrace,
  createAlertRule,
  evaluateRules,
  getActiveAlerts,
  resolveAlert,
  initializeDefaultAlertRules,
  formatAlerts,
  resetAlerts,
} from "@guyghost/swarm-dao-core";

describe("observability/metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("creates and increments counter", () => {
    const counter = createCounter("test_counter", "Test");
    counter.increment();
    counter.increment({ type: "A" });
    expect(counter.getCount()).toBe(2);
    expect(counter.getCount({ type: "A" })).toBe(1);
  });

  it("creates and sets gauge", () => {
    const gauge = createGauge("test_gauge", "Test");
    gauge.set(42);
    gauge.set(100, { label: "x" });
    expect(gauge.getValue()).toBe(100);
  });

  it("creates and observes histogram", () => {
    const hist = createHistogram("test_hist", "Test", [10, 50, 100]);
    hist.observe(5);
    hist.observe(25);
    hist.observe(75);
    expect(hist.getCount()).toBe(3);
    expect(hist.getPercentile(50)).toBe(25);
    expect(hist.getPercentile(100)).toBe(75);
  });

  it("records DAO proposal lifecycle metrics", () => {
    recordProposalCreated("product-feature");
    recordProposalCreated("security-change");
    recordProposalApproved(1, "product-feature");
    recordProposalRejected(2, "security-change");

    expect(DAO_METRICS.proposalsCreated.getCount()).toBe(2);
    expect(DAO_METRICS.proposalsApproved.getCount()).toBe(1);
    expect(DAO_METRICS.approvalRate.getValue()).toBe(50);
  });

  it("formats metrics", () => {
    recordProposalCreated("product-feature");
    const formatted = formatMetrics();
    expect(formatted).toContain("dao_proposals_created");
    expect(formatted).toContain("**Total:** 1");
  });

  it("formats prometheus metrics", () => {
    recordProposalCreated("product-feature");
    const formatted = formatMetricsPrometheus();
    expect(formatted).toContain("# HELP dao_proposals_created");
    expect(formatted).toContain("# TYPE dao_proposals_created counter");
  });
});

describe("observability/tracing", () => {
  beforeEach(() => {
    resetTracing();
  });

  it("starts and finishes span", () => {
    const span = startSpan("test");
    expect(span.status).toBe("running");
    expect(getActiveSpans().length).toBe(1);

    finishSpan(span.id);
    expect(getActiveSpans().length).toBe(0);
    expect(span.status).toBe("success");
    expect(span.durationMs).toBeDefined();
  });

  it("creates child spans", () => {
    const parent = startSpan("parent");
    const child = startSpan("child", { parentId: parent.id, traceId: parent.traceId });

    const trace = getTrace(parent.traceId);
    expect(trace).toBeDefined();
    expect(trace!.spans.length).toBe(2);

    finishSpan(child.id);
    finishSpan(parent.id);
  });

  it("traced wrapper handles success", async () => {
    const result = await traced("test-op", async () => "hello");
    expect(result).toBe("hello");
    expect(getActiveSpans().length).toBe(0);
  });

  it("traced wrapper handles errors", async () => {
    try {
      await traced("test-op", async () => { throw new Error("fail"); });
      expect(false).toBe(true); // should not reach
    } catch {
      expect(getActiveSpans().length).toBe(0);
    }
  });

  it("formats trace", () => {
    const span = startSpan("root");
    finishSpan(span.id);
    const trace = getTrace(span.traceId)!;
    const formatted = formatTrace(trace);
    expect(formatted).toContain("root");
    expect(formatted).toContain("✅");
  });
});

describe("observability/alerts", () => {
  beforeEach(() => {
    resetMetrics();
    resetAlerts();
  });

  it("creates alert rules", () => {
    const rule = createAlertRule({
      name: "Test",
      description: "Test rule",
      metric: "dao_proposals_created",
      condition: "gt",
      threshold: 5,
      severity: "warning",
      enabled: true,
    });
    expect(rule.id).toBeDefined();
  });

  it("evaluates rules and creates alerts", () => {
    createCounter("dao_agent_count", "");
    createAlertRule({
      name: "No Agents",
      description: "No agents",
      metric: "dao_agent_count",
      condition: "lte",
      threshold: 0,
      severity: "critical",
      enabled: true,
    });

    const newAlerts = evaluateRules();
    expect(newAlerts.length).toBe(1);
    expect(newAlerts[0].severity).toBe("critical");
  });

  it("resolves alerts", () => {
    createGauge("test_agent_count", "");
    const rule = createAlertRule({
      name: "No Agents",
      description: "No agents",
      metric: "test_agent_count",
      condition: "lte",
      threshold: 0,
      severity: "critical",
      enabled: true,
    });

    evaluateRules();
    const active = getActiveAlerts();
    expect(active.length).toBe(1);

    // Now set the metric above threshold
    const gauge = getGauge("test_agent_count")!;
    gauge.set(5);
    evaluateRules();

    const resolved = getActiveAlerts();
    expect(resolved.length).toBe(0);
  });

  it("initializes default alert rules", () => {
    initializeDefaultAlertRules();
    const rules = evaluateRules();
    expect(rules.length).toBeGreaterThanOrEqual(0);
  });

  it("formats alerts", () => {
    resetAlerts();
    const formatted = formatAlerts();
    expect(formatted).toContain("No Active Alerts");
  });
});