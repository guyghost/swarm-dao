interface JsonRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowStatuses?: number[];
  maxAttempts?: number;
  // Per-call fetch injection. Defaults to the runtime global `fetch`, so
  // production behaviour is unchanged; tests pass a lightweight wrapper to keep
  // the retry assertions isolated from the shared global (other test modules
  // mutate globalThis.fetch concurrently and never restore it).
  _fetch?: FetchImplementation;
}

export class HttpRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

// HTTP keep-alive (connection reuse) is handled automatically by the Bun fetch
// runtime, which pools and reuses TCP connections by default. There is no
// standard, dependency-free fetch option to toggle this in Bun (the `dispatcher`
// option is undici/Node-specific and unavailable here), so we rely on the runtime
// and focus this change on idempotency-aware retry with backoff.

// Backoff tuning. `Retry-After` is honoured but capped so retries stay fast.
const MAX_RETRY_AFTER_MS = 5_000;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 1_000;
const SNIPPET_MAX_LENGTH = 300;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "PUT" || method === "DELETE";
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Delta-seconds (non-negative integer).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  // HTTP-date.
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return null;
}

// Exponential backoff with full jitter. `attempt` is 1-based.
function exponentialBackoff(attempt: number): number {
  const capped = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  return Math.floor(Math.random() * capped);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippetFrom(text: string): string {
  const trimmed = text.trim();
  return trimmed ? ` - ${truncate(trimmed, SNIPPET_MAX_LENGTH)}` : "";
}

// Minimal response shape consumed by `performAttempt`. Defined as an interface
// so tests can inject a lightweight fetch wrapper without constructing real
// `Response` objects.
interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

type FetchImplementation = (url: string, init?: RequestInit) => Promise<HttpResponseLike>;

type AttemptOutcome =
  | { kind: "success"; status: number; data: unknown }
  | { kind: "retryable-status"; status: number; text: string; retryAfterMs: number | null }
  | { kind: "non-retryable-status"; status: number; text: string }
  | { kind: "abort" }
  | { kind: "network-error"; error: unknown }
  | { kind: "json-error"; error: Error };

// Runs a single fetch attempt. `timeoutMs` is the PER-ATTEMPT timeout: each
// attempt owns its own AbortController, so a single attempt's observable
// behaviour matches the pre-retry implementation exactly.
async function performAttempt(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  allowStatuses: number[],
  timeoutMs: number,
  fetchImpl: FetchImplementation,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = typeof response.text === "function" ? await response.text() : "";
    const isAllowedFailure = allowStatuses.includes(response.status);
    if (response.ok || isAllowedFailure) {
      if (!text.trim()) {
        return { kind: "success", status: response.status, data: null };
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (error) {
        return {
          kind: "json-error",
          error: new Error(
            `Invalid JSON response from ${url}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
      return { kind: "success", status: response.status, data };
    }
    if (isRetryableStatus(response.status)) {
      let retryAfterMs: number | null = null;
      try {
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      } catch {
        retryAfterMs = null;
      }
      return { kind: "retryable-status", status: response.status, text, retryAfterMs };
    }
    return { kind: "non-retryable-status", status: response.status, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "abort" };
    }
    return { kind: "network-error", error };
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestJson<T>(
  url: string,
  { timeoutMs = 15_000, allowStatuses = [], maxAttempts, _fetch, ...options }: JsonRequestOptions = {},
): Promise<{ status: number; data: T | null }> {
  const fetchImpl: FetchImplementation = _fetch ?? globalThis.fetch;
  const method = options.method?.toUpperCase() ?? "GET";
  const defaultAttempts = isIdempotentMethod(method) ? 3 : 1;
  const attempts = Math.max(1, Math.trunc(maxAttempts ?? defaultAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const isLastAttempt = attempt === attempts;
    const outcome = await performAttempt(url, options, allowStatuses, timeoutMs, fetchImpl);

    switch (outcome.kind) {
      case "success":
        return { status: outcome.status, data: outcome.data as T | null };
      case "json-error":
        throw outcome.error;
      case "non-retryable-status":
        throw new HttpRequestError(
          `HTTP ${outcome.status} for ${url}${snippetFrom(outcome.text)}`,
          outcome.status,
          url,
        );
      case "retryable-status":
        if (isLastAttempt) {
          throw new HttpRequestError(
            `HTTP ${outcome.status} for ${url}${snippetFrom(outcome.text)}`,
            outcome.status,
            url,
          );
        }
        await sleep(outcome.retryAfterMs ?? exponentialBackoff(attempt));
        break;
      case "abort":
        if (isLastAttempt) {
          throw new Error(`Request timed out after ${timeoutMs}ms for ${url}`);
        }
        await sleep(exponentialBackoff(attempt));
        break;
      case "network-error":
        if (isLastAttempt) {
          throw outcome.error;
        }
        await sleep(exponentialBackoff(attempt));
        break;
    }
  }
  // Unreachable: the loop always returns or throws on the final attempt.
  throw new Error(`requestJson: exhausted all attempts for ${url}`);
}
