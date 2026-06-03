import { beforeEach, describe, expect, it } from "bun:test";
import { finishSpan, formatTracesSummary, resetTracing, startSpan } from "../src/observability/tracing.js";

describe("observability/tracing.ts", () => {
  beforeEach(() => {
    resetTracing();
  });

  it("starts and finishes spans", () => {
    const span = startSpan("trace-test");
    const done = finishSpan(span.id);
    expect(done?.status).toBe("success");
    expect(formatTracesSummary()).toContain("Total traces");
  });
});
