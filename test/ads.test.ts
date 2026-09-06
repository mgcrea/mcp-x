import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { AdsApiClient } from "#/client/ads";
import { staticTokenProvider } from "#/client/auth";
import { PreconditionError, XApiRequestError } from "#/client/errors";
import { initOf, json, urlOf } from "#test/helpers";

const clientWith = (fetchImpl: typeof fetch, baseUrl = "https://ads.test") =>
  new AdsApiClient({
    tokenProvider: staticTokenProvider("t"),
    fetch: fetchImpl,
    maxRetries: 0,
    baseUrl,
  });

describe("cursor pagination", () => {
  it("follows next_cursor and sends it back as cursor, re-sending the original query", async () => {
    const f = vi.fn(async (url: string) =>
      String(url).includes("cursor=page2")
        ? json({ data: [{ id: "c" }], next_cursor: null })
        : json({ data: [{ id: "a" }, { id: "b" }], next_cursor: "page2" }),
    );
    const page = await clientWith(f as unknown as typeof fetch).paginateCursor(
      "/12/accounts/1/campaigns",
      { with_deleted: true },
      { maxItems: 100 },
    );

    expect(page.data).toHaveLength(3);
    expect(page.pages).toBe(2);
    expect(page.nextCursor).toBeUndefined();
    // The second request must carry the cursor *and* repeat the filter, or
    // page two silently describes a different collection than page one.
    expect(urlOf(f, 1)).toContain("cursor=page2");
    expect(urlOf(f, 1)).toContain("with_deleted=true");
  });

  it("stops at maxItems and reports the cursor it did not follow", async () => {
    const f = vi.fn(async () => json({ data: [{ id: "a" }, { id: "b" }], next_cursor: "more" }));
    const page = await clientWith(f as unknown as typeof fetch).paginateCursor(
      "/12/accounts/1/campaigns",
      {},
      { maxItems: 2 },
    );
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).toBe("more");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("stops at maxPages so a long collection cannot loop forever", async () => {
    const f = vi.fn(async () => json({ data: [{ id: "a" }], next_cursor: "always" }));
    const page = await clientWith(f as unknown as typeof fetch).paginateCursor(
      "/12/accounts/1/campaigns",
      {},
      { maxItems: 1000, maxPages: 3 },
    );
    expect(page.pages).toBe(3);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("treats a null next_cursor as the last page, not as a cursor", async () => {
    const f = vi.fn(async () => json({ data: [{ id: "a" }], next_cursor: null }));
    const page = await clientWith(f as unknown as typeof fetch).paginateCursor(
      "/12/accounts/1/campaigns",
      {},
      { maxItems: 100 },
    );
    expect(page.pages).toBe(1);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("error messages", () => {
  const failing = (status: number, body: unknown, baseUrl?: string) =>
    clientWith(vi.fn(async () => json(body, { status })) as unknown as typeof fetch, baseUrl).get(
      "/12/accounts",
    );

  it("reads the gateway's legacy numeric envelope and blames the token, not the scopes", async () => {
    await expect(
      failing(400, { errors: [{ message: "Bad Authentication data", code: 215 }] }),
    ).rejects.toThrow(/gateway rejected the credentials.*x-mcp login/s);
  });

  it("tells a 401 to log in again rather than to re-check the scopes", async () => {
    await expect(
      failing(401, { errors: [{ code: "UNAUTHORIZED_ACCESS", message: "not authenticated" }] }),
    ).rejects.toThrow(/predates your Ads API approval.*x-mcp login/s);
  });

  // Verified against the live API: one token gets 200 from ads-api.x.com/mcp and
  // UNAUTHORIZED_CLIENT_APPLICATION from /12/accounts at the same moment, so the
  // message has to separate the console toggle from the human review.
  it("distinguishes the Ads Project toggle from Ads REST approval on a 403", async () => {
    await expect(
      failing(403, {
        errors: [
          {
            code: "UNAUTHORIZED_CLIENT_APPLICATION",
            message:
              "The client application making this request does not have access to Twitter Ads API",
          },
        ],
      }),
    ).rejects.toThrow(/hosted Ads MCP.*Ads API Access Form.*human review/s);
  });

  // A sandbox id 404s against production and vice versa, and nothing in X's
  // response says which environment you are pointed at.
  it("names the environment in a 404, because ids do not carry across", async () => {
    await expect(
      failing(404, { errors: [{ code: "NOT_FOUND" }] }, "https://ads-api-sandbox.twitter.com"),
    ).rejects.toThrow(/SANDBOX/);
    await expect(
      failing(404, { errors: [{ code: "NOT_FOUND" }] }, "https://ads-api.x.com"),
    ).rejects.toThrow(/PRODUCTION/);
  });

  it("quotes X's own CAPS_CASE code and offending parameter", async () => {
    await expect(
      failing(400, {
        errors: [{ code: "INVALID_PARAMETER", message: "invalid date", parameter: "start_time" }],
      }),
    ).rejects.toThrow(/INVALID_PARAMETER.*invalid date.*start_time/s);
  });

  it("carries the status through on the thrown error", async () => {
    await expect(failing(403, { errors: [] })).rejects.toMatchObject({
      name: "XApiRequestError",
      status: 403,
    });
  });
});

describe("rate limits", () => {
  it("records the endpoint, account and cost budgets separately", async () => {
    const f = vi.fn(async () =>
      json(
        { data: [] },
        {
          headers: {
            "x-rate-limit-limit": "100",
            "x-rate-limit-remaining": "99",
            "x-account-rate-limit-limit": "10000",
            "x-account-rate-limit-remaining": "9000",
            "x-cost-rate-limit-remaining": "500",
          },
        },
      ),
    );
    const client = clientWith(f as unknown as typeof fetch);
    await client.get("/12/accounts/18ce54d4x5t/campaigns");
    const scopes = client.rateLimitStatus().map((s) => s.scope);
    expect(scopes).toEqual(expect.arrayContaining(["endpoint", "account", "cost"]));
    expect(client.rateLimitStatus().every((s) => s.api === "ads")).toBe(true);
  });

  // Ads ids are alphanumeric, so the v2 digit-run collapse never fires on them
  // and every entity would otherwise leak its own bucket.
  it("collapses alphanumeric ads ids into one bucket per endpoint", async () => {
    const f = vi.fn(async () => json({ data: [] }, { headers: { "x-rate-limit-limit": "100" } }));
    const client = clientWith(f as unknown as typeof fetch);
    await client.get("/12/accounts/18ce54d4x5t/campaigns");
    await client.get("/12/accounts/9aa1bb2cc3d/campaigns");
    expect(client.rateLimitStatus()).toHaveLength(1);
    expect(client.rateLimitStatus()[0]?.endpoint).toBe("GET /12/accounts/:id/campaigns");
  });
});

describe("requests", () => {
  it("sends write parameters in the query string, with no JSON body", async () => {
    const f = vi.fn(async () => json({ data: {} }));
    await clientWith(f as unknown as typeof fetch).post("/12/accounts/1/campaigns", {
      name: "Q3 launch",
      daily_budget_amount_local_micro: 50_000_000,
    });
    expect(urlOf(f)).toContain("daily_budget_amount_local_micro=50000000");
    expect(initOf(f).body).toBeUndefined();
    expect((initOf(f).headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("always authenticates with the user context", async () => {
    const f = vi.fn(async () => json({ data: [] }));
    await clientWith(f as unknown as typeof fetch).get("/12/accounts");
    expect((initOf(f).headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("derives the sandbox flag from the base URL", () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(clientWith(f, "https://ads-api-sandbox.twitter.com").sandbox).toBe(true);
    expect(clientWith(f, "https://ads-api.x.com").sandbox).toBe(false);
  });
});

describe("analytics download", () => {
  const gz = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(gzipSync(Buffer.from(JSON.stringify(body))), { status: 200, headers });

  it("decompresses a result file", async () => {
    const f = vi.fn(async () => gz({ data: [{ id: "abc" }] }));
    const out = await clientWith(f as unknown as typeof fetch).downloadGzipped(
      "https://ton.twimg.com/advertiser-api-async-analytics/stats_job_1.json.gz",
    );
    expect(JSON.parse(out.text)).toMatchObject({ data: [{ id: "abc" }] });
  });

  // The URL is presigned by an object store. Any Authorization header makes it
  // reject the request, so sending one would break every download.
  it("sends no Authorization header, because the URL is presigned", async () => {
    const f = vi.fn(async () => gz({ data: [] }));
    await clientWith(f as unknown as typeof fetch).downloadGzipped(
      "https://ton.twimg.com/advertiser-api-async-analytics/stats_job_1.json.gz",
    );
    expect((initOf(f).headers as Record<string, string>).Authorization).toBeUndefined();
  });

  // The URL comes out of an API response, so following it unchecked would be
  // an SSRF primitive in a server that advertises a small attack surface.
  it("refuses a host outside X's own", async () => {
    const f = vi.fn(async () => gz({ data: [] }));
    await expect(
      clientWith(f as unknown as typeof fetch).downloadGzipped(
        "https://evil.example.com/x.json.gz",
      ),
    ).rejects.toBeInstanceOf(PreconditionError);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses plain HTTP even on an allowed host", async () => {
    const f = vi.fn(async () => gz({ data: [] }));
    await expect(
      clientWith(f as unknown as typeof fetch).downloadGzipped("http://ton.twimg.com/x.json.gz"),
    ).rejects.toBeInstanceOf(PreconditionError);
  });

  it("refuses an oversized download before fetching the body", async () => {
    const f = vi.fn(async () => gz({ data: [] }, { "content-length": "99999999" }));
    const client = new AdsApiClient({
      tokenProvider: staticTokenProvider("t"),
      fetch: f as unknown as typeof fetch,
      baseUrl: "https://ads.test",
      maxDownloadBytes: 1000,
    });
    await expect(client.downloadGzipped("https://ton.twimg.com/x.json.gz")).rejects.toThrow(
      /over the 1000-byte limit/,
    );
  });

  // A modest gzip of repetitive JSON expands enormously; without the output cap
  // a big enough report is an OOM rather than an error.
  it("refuses a gzip bomb rather than decompressing it", async () => {
    const bomb = gzipSync(Buffer.alloc(2_000_000, 0x61));
    const f = vi.fn(async () => new Response(bomb, { status: 200 }));
    const client = new AdsApiClient({
      tokenProvider: staticTokenProvider("t"),
      fetch: f as unknown as typeof fetch,
      baseUrl: "https://ads.test",
      maxDownloadBytes: 10_000,
    });
    await expect(client.downloadGzipped("https://ton.twimg.com/x.json.gz")).rejects.toBeInstanceOf(
      PreconditionError,
    );
  });

  it("says the URL expired when the store refuses it", async () => {
    const f = vi.fn(async () => new Response("", { status: 403 }));
    await expect(
      clientWith(f as unknown as typeof fetch).downloadGzipped("https://ton.twimg.com/x.json.gz"),
    ).rejects.toThrow(/expire/);
  });
});

describe("XApiRequestError shape", () => {
  it("preserves X's error array for the caller to inspect", async () => {
    const f = vi.fn(async () =>
      json({ errors: [{ code: "INVALID_PARAMETER", parameter: "entity" }] }, { status: 400 }),
    );
    await expect(
      clientWith(f as unknown as typeof fetch).get("/12/accounts"),
    ).rejects.toMatchObject({ errors: [{ code: "INVALID_PARAMETER", parameter: "entity" }] });
    expect(XApiRequestError).toBeDefined();
  });
});
