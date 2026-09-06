import { describe, expect, it, vi } from "vitest";

import { bearerTokenProvider, staticTokenProvider, type TokenProvider } from "#/client/auth";
import { UserContextRequiredError, XApiRequestError } from "#/client/errors";
import { XApiClient } from "#/client/x";
import { initOf, json, urlOf } from "#test/helpers";

const clientWith = (fetchImpl: typeof fetch, provider: TokenProvider = staticTokenProvider("t")) =>
  new XApiClient({
    tokenProvider: provider,
    fetch: fetchImpl,
    maxRetries: 3,
    baseUrl: "https://x.test",
  });

describe("query building", () => {
  it("comma-joins arrays rather than repeating the key", async () => {
    const f = vi.fn(async () => json({ data: [] }));
    await clientWith(f as unknown as typeof fetch).get("/2/tweets", {
      ids: ["1", "2", "3"],
      "tweet.fields": ["id", "text"],
    });
    expect(urlOf(f)).toBe("https://x.test/2/tweets?ids=1%2C2%2C3&tweet.fields=id%2Ctext");
  });

  it("drops undefined and empty-array params instead of sending them", async () => {
    const f = vi.fn(async () => json({ data: [] }));
    await clientWith(f as unknown as typeof fetch).get("/2/tweets", {
      ids: ["1"],
      missing: undefined,
      empty: [],
    });
    expect(urlOf(f)).toBe("https://x.test/2/tweets?ids=1");
  });
});

describe("auth context", () => {
  it("sends the app token by default", async () => {
    const f = vi.fn(async () => json({ data: [] }));
    const provider = {
      ...staticTokenProvider("app-token"),
      getToken: vi.fn(async () => "app-token"),
    };
    await clientWith(f as unknown as typeof fetch, provider as TokenProvider).get("/2/tweets");
    expect(provider.getToken).toHaveBeenCalledWith("app");
    expect((initOf(f).headers as Record<string, string>).Authorization).toBe("Bearer app-token");
  });

  it("propagates UserContextRequiredError with the login hint", async () => {
    const f = vi.fn(async () => json({ data: [] }));
    const client = clientWith(f as unknown as typeof fetch, bearerTokenProvider("bearer"));
    await expect(client.get("/2/users/1/bookmarks", {}, "user")).rejects.toThrow(
      UserContextRequiredError,
    );
    await expect(client.get("/2/users/1/bookmarks", {}, "user")).rejects.toThrow(/x-mcp login/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("retries", () => {
  it("invalidates the right context and retries once on 401", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ title: "Unauthorized" }, { status: 401 }))
      .mockResolvedValueOnce(json({ data: { id: "1" } }));
    const invalidate = vi.fn();
    const provider = { ...staticTokenProvider("t"), invalidate };
    const res = await clientWith(f as unknown as typeof fetch, provider as TokenProvider).get(
      "/2/tweets/1",
      {},
      "user",
    );
    expect(invalidate).toHaveBeenCalledWith("user");
    expect(f).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ data: { id: "1" } });
  });

  it("honors Retry-After on a 429", async () => {
    vi.useFakeTimers();
    try {
      const f = vi
        .fn()
        .mockResolvedValueOnce(json({}, { status: 429, headers: { "Retry-After": "2" } }))
        .mockResolvedValueOnce(json({ data: [] }));
      const promise = clientWith(f as unknown as typeof fetch).get("/2/tweets");
      await vi.advanceTimersByTimeAsync(2000);
      await promise;
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxRetries and throws with the status", async () => {
    const f = vi.fn(async () => json({ title: "Server error" }, { status: 500 }));
    vi.useFakeTimers();
    try {
      const client = new XApiClient({
        tokenProvider: staticTokenProvider("t"),
        fetch: f as unknown as typeof fetch,
        maxRetries: 1,
        baseUrl: "https://x.test",
      });
      const promise = client.get("/2/tweets").catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await promise;
      expect(err).toBeInstanceOf(XApiRequestError);
      expect((err as XApiRequestError).status).toBe(500);
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("error messages", () => {
  it("points a 401 at both credentials", async () => {
    const f = vi.fn(async () => json({ title: "Unauthorized" }, { status: 401 }));
    const client = new XApiClient({
      tokenProvider: staticTokenProvider("t"),
      fetch: f as unknown as typeof fetch,
      maxRetries: 0,
      baseUrl: "https://x.test",
    });
    await expect(client.get("/2/tweets")).rejects.toThrow(/X_BEARER_TOKEN[\s\S]*x-mcp login/);
  });

  it("names the enrollment trap first on a 403 — the usual cause, and not a scope problem", async () => {
    const f = vi.fn(async () => json({ title: "Forbidden" }, { status: 403 }));
    let message = "";
    try {
      await clientWith(f as unknown as typeof fetch).get("/2/users/1/bookmarks", {}, "user");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/console\.x\.com/);
    expect(message).toMatch(/Pay-per-use/);
    expect(message).toMatch(/Production/);
    // Tier and scopes are still mentioned, but after the more likely cause.
    expect(message.indexOf("Pay-per-use")).toBeLessThan(message.indexOf("access tier"));
  });

  it("quotes the rate-limit window on a 429", async () => {
    const f = vi.fn(async () =>
      json(
        {},
        {
          status: 429,
          headers: {
            "x-rate-limit-limit": "450",
            "x-rate-limit-remaining": "0",
            "x-rate-limit-reset": "1784000000",
          },
        },
      ),
    );
    const client = new XApiClient({
      tokenProvider: staticTokenProvider("t"),
      fetch: f as unknown as typeof fetch,
      maxRetries: 0,
      baseUrl: "https://x.test",
    });
    await expect(client.get("/2/tweets/search/recent")).rejects.toThrow(/0\/450 remaining/);
  });
});

describe("rate limit ledger", () => {
  it("buckets by endpoint shape, not by concrete id", async () => {
    const f = vi.fn(async () =>
      json(
        { data: {} },
        { headers: { "x-rate-limit-limit": "900", "x-rate-limit-remaining": "899" } },
      ),
    );
    const client = clientWith(f as unknown as typeof fetch);
    await client.get("/2/tweets/1799000000000000001");
    await client.get("/2/tweets/1799000000000000002");
    const status = client.rateLimitStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.endpoint).toBe("GET /2/tweets/:id");
  });

  it("records nothing when the response carries no rate-limit headers", async () => {
    const f = vi.fn(async () => json({ data: {} }));
    const client = clientWith(f as unknown as typeof fetch);
    await client.get("/2/tweets/1");
    expect(client.rateLimitStatus()).toHaveLength(0);
  });
});

describe("paginate", () => {
  const page = (ids: string[], nextToken?: string) =>
    json({
      data: ids.map((id) => ({ id })),
      includes: { users: [{ id: `u${ids[0]}` }] },
      meta: nextToken ? { next_token: nextToken } : {},
    });

  it("follows next_token via pagination_token and stops when it runs out", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(page(["1", "2"], "cursor-a"))
      .mockResolvedValueOnce(page(["3", "4"]));
    const res = await clientWith(f as unknown as typeof fetch).paginate(
      "/2/tweets/search/recent",
      { query: "rust" },
      { maxItems: 100 },
    );
    expect(res.data).toHaveLength(4);
    expect(res.pages).toBe(2);
    expect(urlOf(f, 0)).not.toContain("pagination_token");
    expect(urlOf(f, 1)).toContain("pagination_token=cursor-a");
    // The original query has to ride along on every page, unlike a links.next API.
    expect(urlOf(f, 1)).toContain("query=rust");
  });

  it("stops fetching at maxItems but returns every post it paid for", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(page(["1", "2"], "cursor-a"))
      .mockResolvedValueOnce(page(["3", "4"], "cursor-b"));
    const res = await clientWith(f as unknown as typeof fetch).paginate(
      "/2/tweets/search/recent",
      { query: "rust" },
      { maxItems: 3 },
    );
    // X billed four posts; trimming to three would waste one and make
    // cursor-b skip it on the next call.
    expect(res.data).toHaveLength(4);
    expect(f).toHaveBeenCalledTimes(2);
    expect(res.nextToken).toBe("cursor-b");
  });

  it("collects per-id errors from every page", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        json({ data: [{ id: "1" }], errors: [{ value: "9" }], meta: { next_token: "a" } }),
      )
      .mockResolvedValueOnce(json({ data: [{ id: "2" }], errors: [{ value: "8" }], meta: {} }));
    const res = await clientWith(f as unknown as typeof fetch).paginate(
      "/2/tweets/search/recent",
      { query: "rust" },
      { maxItems: 100 },
    );
    expect(res.errors).toEqual([{ value: "9" }, { value: "8" }]);
  });

  it("stops at maxPages even when the cursor keeps going", async () => {
    const f = vi.fn(async () => page(["1"], "endless"));
    const res = await clientWith(f as unknown as typeof fetch).paginate(
      "/2/tweets/search/recent",
      { query: "rust" },
      { maxItems: 1000, maxPages: 3 },
    );
    expect(res.pages).toBe(3);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("collects the includes block from every page", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(page(["1"], "cursor-a"))
      .mockResolvedValueOnce(page(["2"]));
    const res = await clientWith(f as unknown as typeof fetch).paginate(
      "/2/tweets/search/recent",
      { query: "rust" },
      { maxItems: 100 },
    );
    expect(res.includes).toHaveLength(2);
  });
});

describe("bodies", () => {
  it("sends JSON and a content-type on POST, and defaults to the user context", async () => {
    const f = vi.fn(async () => json({ data: { id: "1" } }));
    const provider = { ...staticTokenProvider("t"), getToken: vi.fn(async () => "t") };
    await clientWith(f as unknown as typeof fetch, provider as TokenProvider).post("/2/tweets", {
      text: "hi",
    });
    expect(initOf(f).method).toBe("POST");
    expect(initOf(f).body).toBe('{"text":"hi"}');
    expect(provider.getToken).toHaveBeenCalledWith("user");
  });

  it("returns null for a 204 rather than trying to parse an empty body", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    const res = await clientWith(f as unknown as typeof fetch).del("/2/tweets/1");
    expect(res).toBeNull();
  });
});
