import { beforeEach, describe, expect, it } from "bun:test";
import {
  finishSpan,
  formatTrace,
  formatTracesSummary,
  getAllTraces,
  getSpan,
  getTrace,
  logToSpan,
  resetTracing,
  startSpan,
  tagSpan,
} from "../src/observability/tracing.js";

describe("observability/tracing.ts", () => {
  beforeEach(() => {
    resetTracing();
  });

  it("drops traces past the retention cap", () => {
    for (let i = 0; i < 300; i++) startSpan(`trace-${i}`);
    expect(getAllTraces().length).toBe(256);
  });

  it("starts and finishes spans", () => {
    const span = startSpan("trace-test");
    const done = finishSpan(span.id);
    expect(done?.status).toBe("success");
    expect(formatTracesSummary()).toContain("Total traces");
  });

  it("retrieves active spans, tags them, and records span logs", () => {
    const span = startSpan("op-with-logs", { tags: { env: "test" } });
    expect(getSpan(span.id)?.name).toBe("op-with-logs");

    tagSpan(span.id, "component", "governance");
    logToSpan(span.id, "started deliberation", { proposalId: 1 });

    expect(getSpan(span.id)?.tags).toEqual({ env: "test", component: "governance" });
    expect(getSpan(span.id)?.logs.length).toBe(1);
    expect(getSpan(span.id)?.logs[0]?.message).toBe("started deliberation");

    finishSpan(span.id, "timeout");
    expect(getSpan(span.id)).toBeUndefined();

    const trace = getTrace(span.traceId);
    expect(trace).toBeDefined();
    if (!trace) return;
    const formatted = formatTrace(trace);
    expect(formatted).toContain("started deliberation");
    expect(formatted).toContain("Error: timeout");
  });
});
