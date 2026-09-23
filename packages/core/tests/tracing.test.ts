import { beforeEach, describe, expect, it } from "bun:test";
import {
  finishSpan,
  formatTracesSummary,
  getAllTraces,
  resetTracing,
  startSpan,
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
});
