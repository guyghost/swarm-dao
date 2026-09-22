// ============================================================
// Swarm DAO Core — Distributed Tracing
// ============================================================

export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: "running" | "success" | "error";
  error?: string;
  tags: Record<string, string>;
  logs: SpanLog[];
}

export interface SpanLog {
  timestamp: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface Trace {
  traceId: string;
  spans: Span[];
  rootSpan: Span;
}

/** Finished traces retained per log. Older traces are dropped first. */
const MAX_TRACES = 256;

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Bounded trace log. Each DAO repository owns one so a long-lived host does
 * not mix spans from two roots in a single process-wide map.
 */
export class TraceLog {
  private readonly activeSpans = new Map<string, Span>();
  private readonly traces = new Map<string, Trace>();

  startSpan(
    name: string,
    options?: {
      traceId?: string;
      parentId?: string;
      tags?: Record<string, string>;
    },
  ): Span {
    const traceId = options?.traceId || generateId();
    const spanId = generateId();
    const span: Span = {
      id: spanId,
      traceId,
      parentId: options?.parentId,
      name,
      startTime: new Date().toISOString(),
      status: "running",
      tags: options?.tags || {},
      logs: [],
    };
    this.activeSpans.set(spanId, span);
    if (!options?.parentId) {
      this.traces.set(traceId, { traceId, spans: [span], rootSpan: span });
      this.evict();
    } else {
      const trace = this.traces.get(traceId);
      if (trace) trace.spans.push(span);
    }
    return span;
  }

  finishSpan(spanId: string, error?: string): Span | undefined {
    const span = this.activeSpans.get(spanId);
    if (!span) return undefined;
    span.endTime = new Date().toISOString();
    span.status = error ? "error" : "success";
    span.error = error;
    span.durationMs = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
    this.activeSpans.delete(spanId);
    return span;
  }

  logToSpan(spanId: string, message: string, fields?: Record<string, unknown>): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    span.logs.push({ timestamp: new Date().toISOString(), message, fields });
  }

  tagSpan(spanId: string, key: string, value: string): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;
    span.tags[key] = value;
  }

  getSpan(spanId: string): Span | undefined {
    return this.activeSpans.get(spanId);
  }

  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  getAllTraces(): Trace[] {
    return Array.from(this.traces.values());
  }

  getActiveSpans(): Span[] {
    return Array.from(this.activeSpans.values());
  }

  reset(): void {
    this.activeSpans.clear();
    this.traces.clear();
  }

  private evict(): void {
    while (this.traces.size > MAX_TRACES) {
      const oldest = this.traces.keys().next().value;
      if (oldest === undefined) return;
      const removed = this.traces.get(oldest);
      this.traces.delete(oldest);
      if (!removed) continue;
      for (const span of removed.spans) this.activeSpans.delete(span.id);
    }
  }
}

/** Process-wide log used by callers that do not hold a repository. */
const processTraces = new TraceLog();

export function startSpan(
  name: string,
  options?: {
    traceId?: string;
    parentId?: string;
    tags?: Record<string, string>;
  },
): Span {
  return processTraces.startSpan(name, options);
}

export function finishSpan(spanId: string, error?: string): Span | undefined {
  return processTraces.finishSpan(spanId, error);
}

export function logToSpan(spanId: string, message: string, fields?: Record<string, unknown>): void {
  processTraces.logToSpan(spanId, message, fields);
}

export function tagSpan(spanId: string, key: string, value: string): void {
  processTraces.tagSpan(spanId, key, value);
}

export function getSpan(spanId: string): Span | undefined {
  return processTraces.getSpan(spanId);
}

export function getTrace(traceId: string): Trace | undefined {
  return processTraces.getTrace(traceId);
}

export function getAllTraces(): Trace[] {
  return processTraces.getAllTraces();
}

export function getActiveSpans(): Span[] {
  return processTraces.getActiveSpans();
}

export function resetTracing(): void {
  processTraces.reset();
}

export function formatTrace(trace: Trace): string {
  let output = `# Trace: ${trace.traceId}\n\n`;

  function formatSpan(span: Span, depth: number): void {
    const indent = "  ".repeat(depth);
    const status = span.status === "error" ? "❌" : span.status === "success" ? "✅" : "⏳";
    const duration = span.durationMs !== undefined ? `${span.durationMs}ms` : "running";

    output += `${indent}${status} ${span.name} (${duration})\n`;

    if (span.error) {
      output += `${indent}  Error: ${span.error}\n`;
    }

    for (const log of span.logs) {
      output += `${indent}  [${log.timestamp}] ${log.message}\n`;
    }

    // Find child spans
    const children = trace.spans.filter((s) => s.parentId === span.id);
    for (const child of children) {
      formatSpan(child, depth + 1);
    }
  }

  formatSpan(trace.rootSpan, 0);
  return output;
}

export function formatTracesSummary(): string {
  const allTraces = getAllTraces();
  const active = getActiveSpans();

  let output = "# Traces Summary\n\n";
  output += `**Total traces:** ${allTraces.length}\n`;
  output += `**Active spans:** ${active.length}\n\n`;

  for (const trace of allTraces.slice(-10)) {
    const root = trace.rootSpan;
    const duration = root.durationMs !== undefined ? `${root.durationMs}ms` : "running";
    const status = root.status === "error" ? "❌" : root.status === "success" ? "✅" : "⏳";
    output += `- ${status} ${root.name} — ${duration} (${trace.spans.length} spans)\n`;
  }

  return output;
}

// ── Helper: traced function wrapper ──────────────────────────

export async function traced<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: { traceId?: string; parentId?: string; tags?: Record<string, string> },
): Promise<T> {
  const span = startSpan(name, options);
  try {
    const result = await fn(span);
    finishSpan(span.id);
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    finishSpan(span.id, message);
    throw error;
  }
}
