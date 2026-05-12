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

const activeSpans = new Map<string, Span>();
const traces = new Map<string, Trace>();

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function startSpan(
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

  activeSpans.set(spanId, span);

  if (!options?.parentId) {
    traces.set(traceId, { traceId, spans: [span], rootSpan: span });
  } else {
    const trace = traces.get(traceId);
    if (trace) {
      trace.spans.push(span);
    }
  }

  return span;
}

export function finishSpan(spanId: string, error?: string): Span | undefined {
  const span = activeSpans.get(spanId);
  if (!span) return undefined;

  span.endTime = new Date().toISOString();
  span.status = error ? "error" : "success";
  span.error = error;

  const start = new Date(span.startTime).getTime();
  const end = new Date(span.endTime).getTime();
  span.durationMs = end - start;

  activeSpans.delete(spanId);
  return span;
}

export function logToSpan(spanId: string, message: string, fields?: Record<string, unknown>): void {
  const span = activeSpans.get(spanId);
  if (!span) return;

  span.logs.push({
    timestamp: new Date().toISOString(),
    message,
    fields,
  });
}

export function tagSpan(spanId: string, key: string, value: string): void {
  const span = activeSpans.get(spanId);
  if (!span) return;
  span.tags[key] = value;
}

export function getSpan(spanId: string): Span | undefined {
  return activeSpans.get(spanId);
}

export function getTrace(traceId: string): Trace | undefined {
  return traces.get(traceId);
}

export function getAllTraces(): Trace[] {
  return Array.from(traces.values());
}

export function getActiveSpans(): Span[] {
  return Array.from(activeSpans.values());
}

export function resetTracing(): void {
  activeSpans.clear();
  traces.clear();
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
