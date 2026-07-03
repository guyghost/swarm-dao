import { describe, expect, it, mock } from "bun:test";
import { HttpRequestError, requestJson } from "../src/integrations/http.js";

interface FakeResponseOptions {
  ok: boolean;
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function fakeResponse({ ok, status, body, headers }: FakeResponseOptions) {
  const lowerHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    lowerHeaders[key.toLowerCase()] = value;
  }
  return {
    ok,
    status,
    text: async () => body ?? "",
    headers: {
      get: (name: string) => lowerHeaders[name.toLowerCase()] ?? null,
    },
  };
}

describe("integrations/http.ts — retry with backoff", () => {
  // `_fetch` injects a local fetch wrapper so retry call counts are asserted in
  // isolation from the shared global `fetch` (other test modules mutate
  // globalThis.fetch concurrently and never restore it).
  it("(a) retries a 503 then succeeds on the second attempt", async () => {
    const fetchMock = mock((_url: string) => Promise.resolve(fakeResponse({ ok: true, status: 200 })))
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 503, body: "down" }))
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, body: JSON.stringify({ hello: "world" }) }));

    const result = await requestJson<{ hello: string }>("https://example.com/a", { _fetch: fetchMock, maxAttempts: 3 });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ hello: "world" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("(b) honours Retry-After: 0 on a 429 then succeeds", async () => {
    const fetchMock = mock((_url: string) => Promise.resolve(fakeResponse({ ok: true, status: 200 })))
      .mockResolvedValueOnce(
        fakeResponse({ ok: false, status: 429, body: "slow down", headers: { "Retry-After": "0" } }),
      )
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, body: JSON.stringify({ ok: true }) }));

    const result = await requestJson<{ ok: boolean }>("https://example.com/b", { _fetch: fetchMock, maxAttempts: 3 });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("(c) does NOT retry a 404 and throws HttpRequestError", async () => {
    const fetchMock = mock((_url: string) =>
      Promise.resolve(fakeResponse({ ok: false, status: 404, body: "Not Found" })),
    );

    const error = await requestJson("https://example.com/c", { _fetch: fetchMock }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpRequestError);
    expect((error as HttpRequestError).status).toBe(404);
    expect((error as HttpRequestError).url).toBe("https://example.com/c");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("(d) retries a network TypeError then succeeds", async () => {
    const fetchMock = mock((_url: string) => Promise.resolve(fakeResponse({ ok: true, status: 200 })))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, body: JSON.stringify({ recovered: true }) }));

    const result = await requestJson<{ recovered: boolean }>("https://example.com/d", {
      _fetch: fetchMock,
      maxAttempts: 3,
    });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("(e) throws HttpRequestError(503) after exhausting maxAttempts", async () => {
    const fetchMock = mock((_url: string) => Promise.resolve(fakeResponse({ ok: false, status: 503, body: "down" })));

    const error = await requestJson("https://example.com/e", { _fetch: fetchMock, maxAttempts: 3 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(HttpRequestError);
    expect((error as HttpRequestError).status).toBe(503);
    expect((error as HttpRequestError).url).toBe("https://example.com/e");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
