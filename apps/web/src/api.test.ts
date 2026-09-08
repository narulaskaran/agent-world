import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

describe("API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not mark a bodyless delete as JSON", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.remove("QA Fern");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("sends If-None-Match and treats 304 as an unchanged snapshot", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 304, headers: { etag: 'W/"abc"' } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.state('W/"abc"');
    expect(result).toEqual({ notModified: true, etag: 'W/"abc"' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get("if-none-match")).toBe('W/"abc"');
  });

  it("surfaces DATABASE_UNAVAILABLE 503 as an ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "DATABASE_UNAVAILABLE" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(api.state()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "DATABASE_UNAVAILABLE",
    } satisfies Partial<ApiError>);
  });
});
