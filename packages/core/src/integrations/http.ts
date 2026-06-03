interface JsonRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowStatuses?: number[];
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

export async function requestJson<T>(
  url: string,
  { timeoutMs = 15_000, allowStatuses = [], ...options }: JsonRequestOptions = {},
): Promise<{ status: number; data: T | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = typeof response.text === "function" ? await response.text() : "";
    const isAllowedFailure = allowStatuses.includes(response.status);
    if (!response.ok && !isAllowedFailure) {
      const snippet = text.trim() ? ` - ${truncate(text.trim(), 300)}` : "";
      throw new HttpRequestError(`HTTP ${response.status} for ${url}${snippet}`, response.status, url);
    }
    if (!text.trim()) {
      return { status: response.status, data: null };
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON response from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: response.status, data: data as T };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms for ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
