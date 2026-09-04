import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

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
});
