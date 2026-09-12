import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "#/client/auth";
import { effectiveScopes, loadConfig, type Config } from "#/config";
import { createServer } from "#/server";
import { initOf, jsonResponse } from "#test/helpers";

const ABSENT = "/nonexistent/config.json";

type Harness = {
  client: Client;
  fetchMock: ReturnType<typeof vi.fn>;
  toolNames: () => Promise<string[]>;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  urls: () => string[];
};

const connect = async (
  env: Record<string, string> = { X_BEARER_TOKEN: "test-bearer" },
  fetchImpl?: ReturnType<typeof vi.fn>,
  /**
   * Most tests inject a token provider that satisfies both contexts, so they
   * never have to stage an OAuth session. Auth-shaped tests set this to build
   * the real provider chain from the config instead.
   */
  opts: { realAuth?: boolean } = {},
): Promise<Harness> => {
  const config: Config = loadConfig(env, ABSENT);
  const fetchMock = fetchImpl ?? vi.fn(async () => jsonResponse({ data: [] }));
  const { server } = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
    ...(opts.realAuth ? {} : { tokenProvider: staticTokenProvider("test-token") }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    fetchMock,
    toolNames: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    call: async (name, args = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) };
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true };
      } catch {
        return { isToolError: res.isError === true, error: text };
      }
    },
    urls: () => fetchMock.mock.calls.map((c) => String(c[0])),
  };
};

describe("with no credentials configured", () => {
  // The regression that produced "MCP error -32000: Connection closed": the
  // server used to exit on startup, taking the credential-free tools with it
  // and leaving no way to discover what to configure.
  it("still connects, and serves the tools that need no credentials", async () => {
    const names = await (await connect({}, undefined, { realAuth: true })).toolNames();
    // x_login and x_logout are here without being usable: a supervisor calls
    // them by name off its own catalog, so they have to exist in order to
    // answer with what is missing rather than with a protocol error.
    expect(names).toEqual([
      "x_build_search_query",
      "x_compose_post",
      "x_get_auth_status",
      "x_login",
      "x_logout",
      "x_validate_article",
      "x_validate_post",
    ]);
  });

  it("does not register the tools that would call the X API", async () => {
    const names = await (await connect({}, undefined, { realAuth: true })).toolNames();
    for (const tool of ["x_get_post", "x_search_recent", "x_get_user", "x_get_usage_report"]) {
      expect(names).not.toContain(tool);
    }
  });

  it("composes a post for free, which is the whole point of still being up", async () => {
    const h = await connect({}, undefined, { realAuth: true });
    const res = await h.call("x_compose_post", {
      text: "works with zero credentials",
      open: false,
    });
    expect(res.valid).toBe(true);
    expect(res.intent_url).toMatch(/^https:\/\/x\.com\/intent\/tweet\?/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("answers x_get_auth_status as a setup guide", async () => {
    const res = await (await connect({}, undefined, { realAuth: true })).call("x_get_auth_status");
    expect(res.configured).toBe(false);
    expect(res.available_without_credentials).toContain("x_compose_post");
    const setup = (res.setup as string[]).join(" ");
    expect(setup).toContain("X_BEARER_TOKEN");
    expect(setup).toContain("X_CLIENT_ID");
    expect(setup).toContain("x-mcp login");
  });
});

/**
 * The exact tool set per configuration. `toEqual`, never `toContain`: adding a
 * tool has to show up as a diff here, so a tool leaking into a gated
 * configuration is a failing test rather than a surprise in a client.
 */
const BEARER_TOOLS = [
  "x_build_search_query",
  "x_compare_article",
  "x_compose_post",
  "x_count_recent",
  "x_get_article",
  "x_get_auth_status",
  "x_get_post",
  "x_get_posts",
  "x_get_quotes",
  "x_get_rate_limit_status",
  "x_get_thread",
  "x_get_usage_report",
  "x_get_user",
  "x_get_user_mentions",
  "x_get_user_posts",
  "x_get_users",
  "x_login",
  "x_logout",
  "x_request",
  "x_search_recent",
  "x_validate_article",
  "x_validate_post",
];
const USER_TOOLS = ["x_get_bookmarks", "x_get_home_timeline"];
const PAID_WRITE_TOOLS = [
  "x_create_article_draft",
  "x_create_post",
  "x_delete_post",
  "x_publish_article",
];
const exact = (...groups: string[][]): string[] => groups.flat().toSorted();

describe("tool registration matrix", () => {
  it("registers the read and free-compose tools with only a bearer token", async () => {
    const names = await (await connect()).toolNames();
    expect(names).toEqual(BEARER_TOOLS);
  });

  it("adds exactly the user-context tools once a client id is configured", async () => {
    const names = await (await connect({ X_BEARER_TOKEN: "t", X_CLIENT_ID: "cid" })).toolNames();
    expect(names).toEqual(exact(BEARER_TOOLS, USER_TOOLS));
  });

  it("adds exactly the paid write tools when both write flags are set", async () => {
    const names = await (
      await connect({
        X_BEARER_TOKEN: "t",
        X_CLIENT_ID: "cid",
        X_ALLOW_WRITES: "1",
        X_WRITE_BACKEND: "api",
      })
    ).toolNames();
    expect(names).toEqual(exact(BEARER_TOOLS, USER_TOOLS, PAID_WRITE_TOOLS));
  });

  it("adds exactly x_search_all when full-archive access is enabled", async () => {
    const names = await (
      await connect({ X_BEARER_TOKEN: "t", X_ENABLE_FULL_ARCHIVE: "1" })
    ).toolNames();
    expect(names).toEqual(exact(BEARER_TOOLS, ["x_search_all"]));
  });

  it("does not register the paid write tools by default", async () => {
    const names = await (await connect()).toolNames();
    expect(names).not.toContain("x_create_post");
    expect(names).not.toContain("x_delete_post");
  });

  it("still hides the paid write tools when allowWrites is on but the backend is intent", async () => {
    const names = await (await connect({ X_BEARER_TOKEN: "t", X_ALLOW_WRITES: "1" })).toolNames();
    expect(names).not.toContain("x_create_post");
    expect(names).not.toContain("x_create_article_draft");
    expect(names).not.toContain("x_publish_article");
  });

  it("registers the paid write tools only when both flags are set", async () => {
    const names = await (
      await connect({
        X_BEARER_TOKEN: "t",
        X_CLIENT_ID: "cid",
        X_ALLOW_WRITES: "1",
        X_WRITE_BACKEND: "api",
      })
    ).toolNames();
    expect(names).toContain("x_create_post");
    expect(names).toContain("x_delete_post");
  });

  // The inversion that is the point of the design: the free path is never gated.
  it("registers x_compose_post in every mode, including the most locked-down one", async () => {
    const modes: Record<string, string>[] = [
      { X_BEARER_TOKEN: "t" },
      { X_BEARER_TOKEN: "t", X_ALLOW_WRITES: "0" },
      {
        X_BEARER_TOKEN: "t",
        X_CLIENT_ID: "c",
        X_ALLOW_WRITES: "1",
        X_WRITE_BACKEND: "api",
      },
    ];
    for (const env of modes) {
      expect(await (await connect(env)).toolNames()).toContain("x_compose_post");
    }
  });

  it("hides the user-context tools without an OAuth client id", async () => {
    const names = await (await connect()).toolNames();
    for (const tool of ["x_get_bookmarks", "x_get_home_timeline"]) {
      expect(names).not.toContain(tool);
    }
    // Status is always available, so you can find out *why* the rest are missing.
    expect(names).toContain("x_get_auth_status");
  });

  // Registered without a client id ON PURPOSE. A supervisor's Sign in button
  // calls `x_login` by name off its own catalog, so hiding the tool turns a
  // missing variable into the SDK's `Tool x_login not found` — a protocol
  // error that names neither the cause nor the fix.
  it("keeps the login tools registered without an OAuth client id", async () => {
    const names = await (await connect()).toolNames();
    for (const tool of ["x_login", "x_logout"]) {
      expect(names).toContain(tool);
    }
  });

  it("refuses x_login without a client id, naming the variable and the callback", async () => {
    const res = await (await connect()).call("x_login", { open: false });
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain("X_CLIENT_ID");
    expect(res.error).toContain("/callback");
  });

  it("registers the user-context tools once a client id is configured", async () => {
    const names = await (await connect({ X_BEARER_TOKEN: "t", X_CLIENT_ID: "cid" })).toolNames();
    for (const tool of ["x_get_bookmarks", "x_get_home_timeline"]) {
      expect(names).toContain(tool);
    }
  });

  it("hides x_search_all unless full-archive access is enabled", async () => {
    expect(await (await connect()).toolNames()).not.toContain("x_search_all");
    const enabled = await connect({ X_BEARER_TOKEN: "t", X_ENABLE_FULL_ARCHIVE: "1" });
    expect(await enabled.toolNames()).toContain("x_search_all");
  });
});

describe("tool annotations", () => {
  it("marks reads read-only and deletes destructive", async () => {
    const h = await connect({
      X_BEARER_TOKEN: "t",
      X_CLIENT_ID: "c",
      X_ALLOW_WRITES: "1",
      X_WRITE_BACKEND: "api",
    });
    const tools = (await h.client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("x_get_post")?.readOnlyHint).toBe(true);
    expect(byName.get("x_search_recent")?.readOnlyHint).toBe(true);
    expect(byName.get("x_delete_post")?.destructiveHint).toBe(true);
    expect(byName.get("x_create_post")?.destructiveHint).toBe(false);
    expect(byName.get("x_get_article")?.readOnlyHint).toBe(true);
    expect(byName.get("x_compare_article")?.readOnlyHint).toBe(true);
    // Public and undoable only by a delete — but it overwrites nothing that existed.
    expect(byName.get("x_publish_article")?.destructiveHint).toBe(false);
    // Not read-only (it may open a browser), but not destructive either.
    expect(byName.get("x_compose_post")?.readOnlyHint).toBe(false);
    expect(byName.get("x_compose_post")?.destructiveHint).toBe(false);
  });
});

describe("x_get_post", () => {
  const POST_RESPONSE = {
    data: [
      {
        id: "1799000000000000001",
        text: "hello world",
        author_id: "44196397",
        public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0, quote_count: 0 },
      },
    ],
    includes: { users: [{ id: "44196397", username: "mgcrea", name: "Olivier" }] },
  };

  it("returns a shaped post with an inlined author and a cost note", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse(POST_RESPONSE)),
    );
    const res = await h.call("x_get_post", { postId: "1799000000000000001" });
    expect(res.post.author).toBe("@mgcrea (Olivier)");
    expect(res.post.url).toBe("https://x.com/mgcrea/status/1799000000000000001");
    expect(res.cost).toMatchObject({ billable_post_reads: 1, estimated_usd: 0.005 });
    expect(res.post).not.toHaveProperty("author_id");
  });

  it("serves a repeat read from cache, issuing no second request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(POST_RESPONSE));
    const h = await connect(undefined, fetchMock);
    await h.call("x_get_post", { postId: "1799000000000000001" });
    const second = await h.call("x_get_post", { postId: "1799000000000000001" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.post.id).toBe("1799000000000000001");
    expect(second.cost).toMatchObject({ billable_post_reads: 0, free_from_cache: 1 });
    expect(second.cost.estimated_usd).toBe(0);
    expect(second.cost.note).toMatch(/UTC midnight/);
  });

  it("explains a post X would not serve", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ errors: [{ value: "1", title: "Not Found Error" }] })),
    );
    const res = await h.call("x_get_post", { postId: "1" });
    expect(res.error).toMatch(/deleted, protected, or from a suspended account/);
  });

  it("rejects a non-numeric post id at the schema, before any request", async () => {
    const h = await connect();
    const res = await h.call("x_get_post", { postId: "not-an-id" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/digits only/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_get_posts", () => {
  it("batches every id into one request rather than N", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "1", text: "a", author_id: "u" },
          { id: "2", text: "b", author_id: "u" },
          { id: "3", text: "c", author_id: "u" },
        ],
        includes: { users: [{ id: "u", username: "someone" }] },
      }),
    );
    const h = await connect(undefined, fetchMock);
    const res = await h.call("x_get_posts", { postIds: ["1", "2", "3"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.urls()[0]).toContain("ids=1%2C2%2C3");
    expect(res.posts).toHaveLength(3);
    expect(res.cost.billable_post_reads).toBe(3);
  });

  it("reports ids X could not serve without failing the call", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "1", text: "a" }],
          errors: [{ value: "2", title: "Not Found Error" }],
        }),
      ),
    );
    const res = await h.call("x_get_posts", { postIds: ["1", "2"] });
    expect(res.posts).toHaveLength(1);
    expect(res.not_found).toEqual(["2"]);
    // Billed for what came back, not for what was asked.
    expect(res.cost.billable_post_reads).toBe(1);
  });

  it("only fetches the ids not already cached", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "1", text: "a" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "2", text: "b" }] }));
    const h = await connect(undefined, fetchMock);
    await h.call("x_get_post", { postId: "1" });
    const res = await h.call("x_get_posts", { postIds: ["1", "2"] });

    expect(h.urls()[1]).toContain("ids=2");
    expect(h.urls()[1]).not.toContain("ids=1");
    expect(res.cost).toMatchObject({ billable_post_reads: 1, free_from_cache: 1 });
  });
});

describe("x_search_recent", () => {
  it("requests the expansions the shaping layer depends on", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [], meta: { result_count: 0 } })),
    );
    await h.call("x_search_recent", { query: "rust -is:retweet" });
    const url = h.urls()[0] ?? "";
    expect(url).toContain("/2/tweets/search/recent");
    expect(url).toContain("query=rust+-is%3Aretweet");
    expect(decodeURIComponent(url)).toContain("expansions=author_id");
    expect(decodeURIComponent(url)).toContain("tweet.fields=created_at");
  });

  it("raises max_results to X's minimum of 10 and returns and bills all ten", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () =>
        jsonResponse({
          data: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), text: `p${i}` })),
          meta: { result_count: 10 },
        }),
      ),
    );
    const res = await h.call("x_search_recent", { query: "rust", maxResults: 3 });
    expect(h.urls()[0]).toContain("max_results=10");
    // X billed ten. Returning three and billing three would waste seven paid
    // posts and under-report the spend by $0.035.
    expect(res.posts).toHaveLength(10);
    expect(res.result_count).toBe(10);
    expect(res.cost).toMatchObject({ billable_post_reads: 10, estimated_usd: 0.05 });
  });

  it("resolves an author sideloaded only on a later page", async () => {
    const h = await connect(
      undefined,
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: Array.from({ length: 10 }, (_, i) => ({
              id: String(i + 1),
              text: `p${i}`,
              author_id: "u1",
            })),
            includes: { users: [{ id: "u1", username: "first" }] },
            meta: { result_count: 10, next_token: "page2" },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ id: "11", text: "late", author_id: "u2" }],
            includes: { users: [{ id: "u2", username: "second" }] },
            meta: { result_count: 1 },
          }),
        ),
    );
    const res = await h.call("x_search_recent", { query: "rust", maxResults: 11 });
    expect(res.posts).toHaveLength(11);
    expect(res.posts[10].author).toBe("@second");
  });
});

describe("x_count_recent", () => {
  it("costs nothing and warns what reading the matches would cost", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [], meta: { total_tweet_count: 5000 } })),
    );
    const res = await h.call("x_count_recent", { query: "rust" });
    expect(res.total_posts).toBe(5000);
    expect(res.cost.estimated_usd).toBe(0);
    expect(res.reading_all_would_cost_usd).toBe(25);
    expect(res.advice).toMatch(/\$25\.00/);
  });

  it("omits the advice when the result set is small", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [], meta: { total_tweet_count: 12 } })),
    );
    const res = await h.call("x_count_recent", { query: "rust" });
    expect(res.advice).toBeUndefined();
  });
});

describe("x_build_search_query", () => {
  it("builds a query and explains it without touching the network", async () => {
    const h = await connect();
    const res = await h.call("x_build_search_query", {
      allWords: "rust async",
      from: ["mgcrea", "@acme"],
      lang: "en",
      isRetweet: false,
    });
    expect(res.query).toBe("rust async (from:mgcrea OR from:acme) lang:en -is:retweet");
    expect(res.valid).toBe(true);
    expect(res.explanation.join(" ")).toMatch(/removes the duplicate noise of reposts/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("flags an empty query rather than returning a blank string as valid", async () => {
    const res = await (await connect()).call("x_build_search_query", {});
    expect(res.valid).toBe(false);
    expect(res.warning).toMatch(/No criteria/);
  });
});

describe("x_compose_post", () => {
  it("returns an intent URL and never calls the API", async () => {
    const h = await connect();
    const res = await h.call("x_compose_post", {
      text: "Shipping v2 today",
      url: "https://acme.dev/v2",
      open: false,
    });
    expect(res.intent_url).toMatch(/^https:\/\/x\.com\/intent\/tweet\?/);
    expect(new URL(res.intent_url).searchParams.get("text")).toBe("Shipping v2 today");
    expect(res.valid).toBe(true);
    expect(res.cost.estimated_usd).toBe(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("still returns the URL when the browser could not be opened", async () => {
    const h = await connect();
    const res = await h.call("x_compose_post", { text: "hi", open: false });
    expect(res.opened).toBe(false);
    expect(res.open_note).toBeDefined();
    expect(res.intent_url).toBeDefined();
    expect(res.next_step).toMatch(/Open the intent_url/);
  });

  it("refuses to hand back a URL for a draft X would reject", async () => {
    const res = await (
      await connect()
    ).call("x_compose_post", {
      text: "a".repeat(270),
      url: "https://acme.dev",
      open: false,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/over X's 280/);
  });

  it("maps inReplyTo into the intent URL", async () => {
    const res = await (
      await connect()
    ).call("x_compose_post", {
      text: "replying",
      inReplyTo: "1799000000000000001",
      open: false,
    });
    expect(new URL(res.intent_url).searchParams.get("in_reply_to")).toBe("1799000000000000001");
  });
});

describe("x_get_usage_report", () => {
  it("accumulates spend across calls and labels itself an estimate", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "1", text: "a" },
            { id: "2", text: "b" },
          ],
        }),
      ),
    );
    await h.call("x_get_posts", { postIds: ["1", "2"] });
    const report = await h.call("x_get_usage_report");

    expect(report.since_process_start.billable_post_reads).toBe(2);
    expect(report.since_process_start.estimated_usd).toBe(0.01);
    expect(report.disclaimer).toMatch(/authoritative/);
    expect(report.pricing.postRead).toBe(0.005);
  });

  it("reports budget headroom when one is configured", async () => {
    const h = await connect({ X_BEARER_TOKEN: "t", X_MONTHLY_BUDGET_USD: "1" });
    const report = await h.call("x_get_usage_report");
    expect(report.budget).toEqual({ limit_usd: 1, remaining_usd: 1 });
  });
});

describe("budget guard", () => {
  it("refuses a search that would cross the ceiling, before spending anything", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    const h = await connect({ X_BEARER_TOKEN: "t", X_MONTHLY_BUDGET_USD: "0.01" }, fetchMock);
    const res = await h.call("x_search_recent", { query: "rust", maxResults: 100 });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/X_MONTHLY_BUDGET_USD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_get_rate_limit_status", () => {
  it("is empty before any request has been made", async () => {
    const res = await (await connect()).call("x_get_rate_limit_status");
    expect(res.endpoints).toEqual([]);
    expect(res.note).toMatch(/No requests issued yet/);
  });
});

describe("x_get_auth_status", () => {
  it("reports a bearer-only install as able to read publicly but not bookmarks", async () => {
    const h = await connect({ X_BEARER_TOKEN: "t" }, undefined, { realAuth: true });
    const res = await h.call("x_get_auth_status");
    expect(res.app_only_bearer).toBe(true);
    expect(res.user.authenticated).toBe(false);
    expect(res.can_read_public).toBe(true);
    expect(res.can_read_bookmarks).toBe(false);
    // The one field a supervisor (Bastion) reads. Top level, boolean, always.
    expect(res.signedIn).toBe(false);
    expect(res.oauth).toBeUndefined();
  });

  it("tells an OAuth install which callback URL to register before logging in", async () => {
    const h = await connect(
      {
        X_CLIENT_ID: "cid",
        X_REDIRECT_URI: "http://127.0.0.1:8799/callback",
        X_TOKEN_FILE: "/nonexistent/x-tokens.json",
      },
      undefined,
      { realAuth: true },
    );
    const res = await h.call("x_get_auth_status");
    expect(res.signedIn).toBe(false);
    expect(res.oauth.redirect_uri).toBe("http://127.0.0.1:8799/callback");
    expect(res.oauth.next_step).toContain("http://127.0.0.1:8799/callback");
    expect(res.oauth.token_file.mode).toBe("absent");
  });

  it("answers the unconfigured state with signedIn false too", async () => {
    const res = await (await connect({}, undefined, { realAuth: true })).call("x_get_auth_status");
    expect(res.signedIn).toBe(false);
  });
});

describe("resolving your own user id", () => {
  /** Stage a logged-in OAuth session on disk, optionally without a recorded id. */
  const stageSession = (over: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "x-tools-"));
    const tokenFile = join(dir, "tokens.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({
        version: 1,
        clientId: "cid",
        scopes: ["tweet.read", "users.read", "bookmark.read", "offline.access"],
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
        obtainedAt: Date.now(),
        username: "mgcrea",
        ...over,
      }),
      { mode: 0o600 },
    );
    return { dir, tokenFile };
  };

  const env = (tokenFile: string) => ({
    X_BEARER_TOKEN: "t",
    X_CLIENT_ID: "cid",
    X_TOKEN_FILE: tokenFile,
  });

  // The dead end this replaced: login tolerates /2/users/me failing, so the id
  // can legitimately be absent — and telling the user to log in again would
  // just hit the same flaky endpoint.
  it("fetches the id from /2/users/me when the token file has none", async () => {
    const { dir, tokenFile } = stageSession();
    try {
      const fetchMock = vi.fn(async (url: string) =>
        String(url).includes("/2/users/me")
          ? jsonResponse({ data: { id: "44196397", username: "mgcrea" } })
          : jsonResponse({ data: [{ id: "1", text: "a bookmark" }] }),
      );
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      const res = await h.call("x_get_bookmarks", {});

      expect(res.isToolError).toBeFalsy();
      expect(h.urls()[0]).toContain("/2/users/me");
      expect(h.urls()[1]).toContain("/2/users/44196397/bookmarks");
      expect(res.posts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the id back, so the next call does not pay for it again", async () => {
    const { dir, tokenFile } = stageSession();
    try {
      const fetchMock = vi.fn(async (url: string) =>
        String(url).includes("/2/users/me")
          ? jsonResponse({ data: { id: "44196397", username: "mgcrea" } })
          : jsonResponse({ data: [] }),
      );
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      await h.call("x_get_bookmarks", {});
      await h.call("x_get_bookmarks", {});

      expect(JSON.parse(readFileSync(tokenFile, "utf8")).userId).toBe("44196397");
      expect(h.urls().filter((u) => u.includes("/2/users/me"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the lookup entirely when the id is already recorded", async () => {
    const { dir, tokenFile } = stageSession({ userId: "44196397" });
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      await h.call("x_get_home_timeline", {});
      expect(h.urls().some((u) => u.includes("/2/users/me"))).toBe(false);
      expect(h.urls()[0]).toContain("/2/users/44196397/timelines/reverse_chronological");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Bastion's Sign in / Sign out buttons call these three tools with no
  // arguments and read `signedIn` from the status reply. That contract is
  // what these two pin.
  it("reports a staged session as signedIn, and x_logout with no arguments ends it", async () => {
    const { dir, tokenFile } = stageSession({ userId: "44196397" });
    try {
      const h = await connect(env(tokenFile), vi.fn(), { realAuth: true });
      const before = await h.call("x_get_auth_status");
      expect(before.signedIn).toBe(true);
      expect(before.user.username).toBe("mgcrea");

      const out = await h.call("x_logout", {});
      expect(out.isToolError).toBeFalsy();
      expect(out).toMatchObject({ signedOut: true, signedIn: false });
      expect(existsSync(tokenFile)).toBe(false);

      const after = await h.call("x_get_auth_status");
      expect(after.signedIn).toBe(false);
      // Logging out twice is not an error; it just reports there was nothing.
      expect((await h.call("x_logout", {})).signedOut).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points at the enrollment trap when X will not identify the account", async () => {
    const { dir, tokenFile } = stageSession();
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
      const h = await connect(env(tokenFile), fetchMock, { realAuth: true });
      const res = await h.call("x_get_bookmarks", {});
      expect(res.isToolError).toBe(true);
      expect(res.error).toMatch(/Pay-per-use.*Production|console\.x\.com/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("user-context tools", () => {
  it("refuses bookmarks with the login hint rather than issuing a doomed request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    const h = await connect(
      {
        X_BEARER_TOKEN: "t",
        X_CLIENT_ID: "cid",
        // Point at a token file that does not exist: nobody has logged in.
        X_TOKEN_FILE: "/nonexistent/x-tokens.json",
      },
      fetchMock,
      { realAuth: true },
    );
    const res = await h.call("x_get_bookmarks", {});
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/x-mcp login/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_get_user", () => {
  it("looks a handle up by username and strips a leading @", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: { id: "44196397", username: "mgcrea" } })),
    );
    const res = await h.call("x_get_user", { username: "@mgcrea" });
    expect(h.urls()[0]).toContain("/2/users/by/username/mgcrea");
    expect(res.user.url).toBe("https://x.com/mgcrea");
    // A user read is billed at twice a post read.
    expect(res.cost.estimated_usd).toBe(0.01);
  });

  it("refuses when both username and userId are given", async () => {
    const res = await (await connect()).call("x_get_user", { username: "a", userId: "1" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/only one/);
  });

  it("refuses when neither is given", async () => {
    const res = await (await connect()).call("x_get_user", {});
    expect(res.isToolError).toBe(true);
  });
});

/**
 * Ads rides the OAuth 2.0 session, so it needs a client id — but it is off
 * unless asked for. The two exact-array assertions above are deliberately left
 * untouched: neither of their environments enables ads, so a correct
 * implementation cannot change them.
 */
const ADS_READ = { X_CLIENT_ID: "cid", X_ADS_ENABLED: "1" };
const ADS_WRITE = { ...ADS_READ, X_ADS_ALLOW_WRITES: "1" };
const ADS_SANDBOX = { ...ADS_WRITE, X_ADS_BASE_URL: "https://ads-api-sandbox.twitter.com" };

const adsNames = async (env: Record<string, string>): Promise<string[]> =>
  (await (await connect(env)).toolNames()).filter((n) => n.startsWith("x_ads_"));

const ADS_READ_TOOLS = [
  "x_ads_create_stats_job",
  "x_ads_download_stats_job",
  "x_ads_get_accounts",
  "x_ads_get_audiences",
  "x_ads_get_campaigns",
  "x_ads_get_funding_instruments",
  "x_ads_get_line_items",
  "x_ads_get_promoted_tweets",
  "x_ads_get_stats",
  "x_ads_get_stats_jobs",
  "x_ads_get_targeting_criteria",
  "x_ads_search_targeting_options",
];

describe("ads tool registration", () => {
  // Cheap, and it keeps holding as ads tools are added later.
  it("registers no ads tools at all unless X_ADS_ENABLED is set", async () => {
    expect(await adsNames({ X_BEARER_TOKEN: "t" })).toEqual([]);
    expect(await adsNames({ X_BEARER_TOKEN: "t", X_CLIENT_ID: "cid" })).toEqual([]);
  });

  it("registers the ads reads, and none of the writes, when only enabled", async () => {
    expect(await adsNames(ADS_READ)).toEqual(ADS_READ_TOOLS);
  });

  it("registers exactly the campaign-mutating tools on top when X_ADS_ALLOW_WRITES is on", async () => {
    expect(await adsNames(ADS_WRITE)).toEqual(
      exact(ADS_READ_TOOLS, [
        "x_ads_create_campaign",
        "x_ads_create_line_item",
        "x_ads_create_promoted_tweet",
        "x_ads_create_targeting_criterion",
        "x_ads_delete_campaign",
        "x_ads_delete_line_item",
        "x_ads_delete_promoted_tweet",
        "x_ads_delete_targeting_criterion",
        "x_ads_set_entity_status",
        "x_ads_update_campaign",
        "x_ads_update_line_item",
      ]),
    );
  });

  // Queuing an analytics job spends nothing, so gating it behind the money
  // switch would make long-range analytics unreachable in the safe config.
  it("keeps the analytics job tools available without enabling writes", async () => {
    const names = await adsNames(ADS_READ);
    expect(names).toContain("x_ads_create_stats_job");
    expect(names).toContain("x_ads_download_stats_job");
  });

  it("registers the sandbox account tool only against the sandbox, and only with writes", async () => {
    expect(await adsNames(ADS_WRITE)).not.toContain("x_ads_create_sandbox_account");
    expect(await adsNames(ADS_SANDBOX)).toContain("x_ads_create_sandbox_account");
    // It creates an entity, so a read-only sandbox profile does not get it.
    expect(await adsNames({ ...ADS_READ, X_ADS_BASE_URL: ADS_SANDBOX.X_ADS_BASE_URL })).toEqual(
      ADS_READ_TOOLS,
    );
  });

  it("leaves ads unregistered, and says why, when it is enabled without a user context", async () => {
    // A Bearer token cannot reach /12/accounts at all. Once this was a fatal
    // config error; that reached the client as "Connection closed" with the
    // explanation swallowed, so now the flag is switched off and the sentence
    // travels with the config to the banner and the status tool.
    const h = await connect({ X_BEARER_TOKEN: "t", X_ADS_ENABLED: "1" });
    expect((await h.toolNames()).filter((n) => n.startsWith("x_ads_"))).toEqual([]);
    const status = await h.call("x_get_auth_status");
    expect(status.warnings).toEqual([expect.stringMatching(/X_CLIENT_ID/)]);
  });

  it("switches ads writes off, and says why, when ads itself is not enabled", async () => {
    const h = await connect({ X_CLIENT_ID: "c", X_ADS_ALLOW_WRITES: "1" });
    expect((await h.toolNames()).filter((n) => n.startsWith("x_ads_"))).toEqual([]);
    const status = await h.call("x_get_auth_status");
    expect(status.warnings).toEqual([expect.stringMatching(/X_ADS_ENABLED/)]);
  });

  it("asks for the ads scopes only when the matching tools exist", () => {
    expect(effectiveScopes(loadConfig({ X_CLIENT_ID: "c" }, ABSENT))).not.toContain("ads.read");
    const read = effectiveScopes(loadConfig(ADS_READ, ABSENT));
    expect(read).toContain("ads.read");
    expect(read).not.toContain("ads.write");
    expect(effectiveScopes(loadConfig(ADS_WRITE, ABSENT))).toContain("ads.write");
  });

  it("marks ads deletes destructive and ads reads read-only", async () => {
    const h = await connect(ADS_WRITE);
    const tools = (await h.client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("x_ads_get_campaigns")?.readOnlyHint).toBe(true);
    expect(byName.get("x_ads_delete_campaign")?.destructiveHint).toBe(true);
    expect(byName.get("x_ads_create_campaign")?.destructiveHint).toBe(false);
    expect(byName.get("x_ads_set_entity_status")?.idempotentHint).toBe(true);
  });
});

describe("ads money handling", () => {
  const adsResponse = (data: unknown) => jsonResponse({ data, request: { params: {} } });

  it("multiplies a major-unit budget into X's micros, and creates PAUSED", async () => {
    const fetchMock = vi.fn(async () => adsResponse({ id: "8v7jo", name: "Q3" }));
    const h = await connect(ADS_WRITE, fetchMock);
    const res = await h.call("x_ads_create_campaign", {
      accountId: "18ce54d4x5t",
      fundingInstrumentId: "lygyi",
      name: "Q3 launch",
      dailyBudget: 50,
      confirm: true,
    });

    const created = h.urls().find((u) => u.includes("/campaigns")) ?? "";
    expect(created).toContain("daily_budget_amount_local_micro=50000000");
    // The whole point of the default: a campaign that exists but spends nothing.
    expect(created).toContain("entity_status=PAUSED");
    expect(res.entity_status).toBe("PAUSED");
    expect(res.budget_sent).toMatchObject({
      daily_budget: 50,
      daily_budget_amount_local_micro: 50_000_000,
    });
    expect(res.cost.estimated_usd).toBe(0);
  });

  it("creates ACTIVE only when explicitly asked to", async () => {
    const fetchMock = vi.fn(async () => adsResponse({ id: "8v7jo" }));
    const h = await connect(ADS_WRITE, fetchMock);
    const res = await h.call("x_ads_create_campaign", {
      accountId: "18ce54d4x5t",
      fundingInstrumentId: "lygyi",
      name: "Q3 launch",
      dailyBudget: 50,
      activateImmediately: true,
      confirm: true,
    });
    expect(h.urls().find((u) => u.includes("/campaigns"))).toContain("entity_status=ACTIVE");
    expect(res.entity_status).toBe("ACTIVE");
  });

  it("cannot be called without confirm, so a stray call cannot spend", async () => {
    const h = await connect(ADS_WRITE);
    const res = await h.call("x_ads_create_campaign", {
      fundingInstrumentId: "lygyi",
      name: "Q3",
      dailyBudget: 50,
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/confirm/);
  });

  // A model reading a bare 50000000 concludes the budget is fifty million.
  it("pairs every micro field it reads back with a human-readable value", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [{ id: "8v7jo", daily_budget_amount_local_micro: 50_000_000 }],
        next_cursor: null,
      }),
    );
    const h = await connect(ADS_READ, fetchMock);
    const res = await h.call("x_ads_get_campaigns", { accountId: "18ce54d4x5t" });
    expect(res.campaigns[0]).toMatchObject({
      daily_budget: 50,
      daily_budget_amount_local_micro: 50_000_000,
    });
  });

  it("rejects a budget that was pre-multiplied into micros", async () => {
    const h = await connect(ADS_WRITE);
    const res = await h.call("x_ads_create_campaign", {
      accountId: "18ce54d4x5t",
      fundingInstrumentId: "lygyi",
      name: "Q3",
      dailyBudget: 50_000_000,
      confirm: true,
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/dailyBudget/);
  });
});

describe("ads account resolution", () => {
  it("resolves the only reachable account and asks X just once", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/campaigns")
        ? jsonResponse({ data: [], next_cursor: null })
        : jsonResponse({ data: [{ id: "18ce54d4x5t", name: "Acme" }], next_cursor: null }),
    );
    const h = await connect(ADS_READ, fetchMock);
    await h.call("x_ads_get_campaigns", {});
    await h.call("x_ads_get_campaigns", {});
    const lookups = h.urls().filter((u) => u.endsWith("count=50"));
    expect(lookups).toHaveLength(1);
    expect(h.urls().some((u) => u.includes("/12/accounts/18ce54d4x5t/campaigns"))).toBe(true);
  });

  // Silently picking the first would create campaigns in the wrong client's
  // account, which spends real money and is invisible in the response.
  it("refuses to guess between several accounts, and lists them", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "aaa", name: "Acme" },
          { id: "bbb", name: "Globex" },
        ],
        next_cursor: null,
      }),
    );
    const res = await (await connect(ADS_READ, fetchMock)).call("x_ads_get_campaigns", {});
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/2 ads accounts/);
    expect(res.details.accounts).toHaveLength(2);
  });

  it("explains an empty account list as an access problem, not an empty result", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [], next_cursor: null }));
    const res = await (await connect(ADS_READ, fetchMock)).call("x_ads_get_campaigns", {});
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/no ads accounts/);
  });
});

describe("ads analytics guards", () => {
  it("refuses a synchronous window wider than X's 7 days, naming the async tool", async () => {
    const h = await connect(ADS_READ);
    const res = await h.call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-20T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/x_ads_create_stats_job/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects times that are not on a whole hour", async () => {
    const res = await (
      await connect(ADS_READ)
    ).call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:30:00Z",
      endTime: "2026-08-02T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/startTime/);
  });

  it("rejects more than the 20 entities X allows per synchronous call", async () => {
    const res = await (
      await connect(ADS_READ)
    ).call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: Array.from({ length: 21 }, (_, i) => `id${i}`),
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-02T00:00:00Z",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/entityIds/);
  });

  it("requires a country when segmenting an async job by metro", async () => {
    const h = await connect(ADS_READ);
    const res = await h.call("x_ads_create_stats_job", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-02T00:00:00Z",
      segmentation: "METROS",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/country/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  // PUBLISHER_NETWORK is a valid line-item placement but not a valid analytics
  // one, which is the kind of thing worth catching in the schema.
  it("rejects a placement the analytics endpoint does not accept", async () => {
    const res = await (
      await connect(ADS_READ)
    ).call("x_ads_get_stats", {
      accountId: "18ce54d4x5t",
      entity: "CAMPAIGN",
      entityIds: ["8v7jo"],
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-02T00:00:00Z",
      placement: "PUBLISHER_NETWORK",
    });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/placement/);
  });
});

describe("x_request", () => {
  const methodsOf = async (h: Harness): Promise<string[]> => {
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "x_request");
    const schema = tool?.inputSchema as unknown as { properties: { method: { enum: string[] } } };
    return schema.properties.method.enum;
  };

  it("is not registered without credentials", async () => {
    const names = await (await connect({}, undefined, { realAuth: true })).toolNames();
    expect(names).not.toContain("x_request");
  });

  it("offers only GET while every write gate is off, and says so in the schema", async () => {
    const h = await connect();
    expect(await methodsOf(h)).toEqual(["GET"]);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "x_request");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it("widens to the mutating methods once writes are enabled with a user context", async () => {
    const h = await connect({ X_CLIENT_ID: "c", X_ALLOW_WRITES: "1", X_WRITE_BACKEND: "api" });
    expect(await methodsOf(h)).toEqual(["GET", "POST", "PUT", "DELETE"]);
  });

  it("passes a v2 GET through raw, with the query joined the way X wants", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [{ id: "1", text: "raw" }], includes: {} })),
    );
    const res = await h.call("x_request", {
      path: "/2/tweets",
      query: { ids: ["1", "2"], "tweet.fields": ["created_at"] },
    });
    expect(res.isToolError).toBeFalsy();
    expect(h.urls()[0]).toContain("/2/tweets?ids=1%2C2&tweet.fields=created_at");
    // Raw: the envelope is X's, includes and all.
    expect(res.response).toEqual({ data: [{ id: "1", text: "raw" }], includes: {} });
    expect(res.cost.note).toMatch(/Not tracked/);
  });

  it("refuses a path outside the two API roots before sending anything", async () => {
    const h = await connect();
    for (const path of ["/1.1/statuses", "//evil.example/x", "/2/../oauth2/token", "tweets"]) {
      const res = await h.call("x_request", { path });
      expect(res.isToolError).toBe(true);
    }
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an Ads path when the Ads client is not configured", async () => {
    const res = await (await connect()).call("x_request", { path: "/12/accounts" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/X_ADS_ENABLED/);
  });

  it("requires confirm on a mutation even when writes are enabled", async () => {
    const h = await connect({ X_CLIENT_ID: "c", X_ALLOW_WRITES: "1", X_WRITE_BACKEND: "api" });
    const refused = await h.call("x_request", { method: "DELETE", path: "/2/tweets/1" });
    expect(refused.isToolError).toBe(true);
    expect(refused.error).toMatch(/confirm/);
    expect(h.fetchMock).not.toHaveBeenCalled();

    const ok = await h.call("x_request", { method: "DELETE", path: "/2/tweets/1", confirm: true });
    expect(ok.isToolError).toBeFalsy();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The three things a review cannot see and a client never reports: a tool
 * with no service-prefixed title collides in the host's permission dialog, a
 * tool with no annotations makes the host guess whether it is destructive, and
 * an argument with no description makes the model guess what to pass. The
 * resolved JSON Schema is read here, atoms included, which is why this lives in
 * `test/` rather than in a source grep.
 */
describe("tool contract", () => {
  const everything = {
    X_BEARER_TOKEN: "t",
    X_CLIENT_ID: "c",
    X_ALLOW_WRITES: "1",
    X_WRITE_BACKEND: "api",
    X_ENABLE_FULL_ARCHIVE: "1",
    X_ADS_ENABLED: "1",
    X_ADS_ALLOW_WRITES: "1",
    X_ADS_BASE_URL: "https://ads-api-sandbox.twitter.com",
  };

  it("registers the whole surface under the fullest configuration", async () => {
    const names = await (await connect(everything)).toolNames();
    expect(names.length).toBeGreaterThanOrEqual(53);
  });

  it("gives every tool a title prefixed with the service name", async () => {
    const tools = (await (await connect(everything)).client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.title, tool.name).toMatch(/^X: /);
    }
  });

  it("gives every tool annotations, and a read-only verdict", async () => {
    const tools = (await (await connect(everything)).client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
    }
  });

  it("describes every input property, so the model never has to guess an argument", async () => {
    const tools = (await (await connect(everything)).client.listTools()).tools;
    const undescribed: string[] = [];
    for (const tool of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties;
      for (const [name, schema] of Object.entries(props ?? {})) {
        if (!schema.description) undescribed.push(`${tool.name}.${name}`);
      }
    }
    expect(undescribed).toEqual([]);
  });
});

describe("x_validate_post", () => {
  it("reports the weighted count without the intent URL, and never calls X", async () => {
    const h = await connect({}, undefined, { realAuth: true });
    const res = await h.call("x_validate_post", { text: "見て", url: "https://a.co" });
    // 2 CJK characters at 2 each, a space, and a URL at 23.
    expect(res).toMatchObject({ valid: true, weighted: 4 + 1 + 23, remaining: 280 - 28 });
    expect(res.intent_url).toBeUndefined();
    expect(res.warnings[0]).toMatch(/23 characters/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("counts a bare short-link domain as a URL, as X does", async () => {
    const h = await connect({}, undefined, { realAuth: true });
    const res = await h.call("x_validate_post", { text: `${"a".repeat(260)} bit.ly/abc` });
    // 260 + space + 23 = 284: X would refuse this, so the draft must not pass.
    expect(res.valid).toBe(false);
    expect(res.weighted).toBe(284);
  });
});

describe("x_create_post cost note", () => {
  const writes = { X_CLIENT_ID: "c", X_ALLOW_WRITES: "1", X_WRITE_BACKEND: "api" };

  it("bills the plain rate for a decimal number that is not a link", async () => {
    const h = await connect(
      writes,
      vi.fn(async () => jsonResponse({ data: { id: "9" } })),
    );
    const res = await h.call("x_create_post", { text: "shipped v1.20, pi is 3.14", confirm: true });
    expect(res.cost.estimated_usd).toBe(0.015);
  });

  it("bills the with-URL rate for a real link", async () => {
    const h = await connect(
      writes,
      vi.fn(async () => jsonResponse({ data: { id: "9" } })),
    );
    const res = await h.call("x_create_post", { text: "read https://acme.dev/v2", confirm: true });
    expect(res.cost.estimated_usd).toBe(0.2);
  });
});

/** A post carrying an Article, as X answers `tweet.fields=article` with both media expansions. */
const ARTICLE_RESPONSE = {
  data: [
    {
      id: "2097319903967539446",
      text: "Some thoughts https://t.co/kravmzPyFJ",
      author_id: "68476943",
      created_at: "2026-09-08T13:43:26.000Z",
      edit_history_tweet_ids: ["2097319903967539446"],
      article: {
        title: "The late Software Developer",
        preview_text: "It is exciting.",
        plain_text: "It is exciting.\nSecond paragraph with @mgcrea and #mcp.",
        cover_media: "3_1",
        media_entities: ["3_2", "3_9"],
        entities: {
          urls: [
            { text: "https://docs.x.com", start: 1, end: 2 },
            { text: "https://docs.x.com", start: 3, end: 4 },
          ],
          mentions: [{ username: "mgcrea", start: 38, end: 45 }],
          hashtags: [{ text: "mcp", start: 50, end: 54 }],
          tweets: [{ id: "1799000000000000001" }],
        },
      },
    },
  ],
  includes: {
    users: [{ id: "68476943", username: "mgcrea", name: "Olivier" }],
    media: [
      { media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/cover.jpg" },
      { media_key: "3_2", type: "photo", url: "https://pbs.twimg.com/media/inline.jpg" },
    ],
  },
};

const ARTICLE_POST = "2097319903967539446";

describe("x_get_article", () => {
  it("returns the whole Article resolved, and asks X for the body field", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse(ARTICLE_RESPONSE)),
    );
    const res = await h.call("x_get_article", { postId: ARTICLE_POST });
    const body = ARTICLE_RESPONSE.data[0]?.article.plain_text as string;

    expect(res.article).toEqual({
      post_id: ARTICLE_POST,
      url: `https://x.com/mgcrea/status/${ARTICLE_POST}`,
      author: "@mgcrea (Olivier)",
      created_at: "2026-09-08T13:43:26.000Z",
      title: "The late Software Developer",
      cover_image: "https://pbs.twimg.com/media/cover.jpg",
      images: ["photo: https://pbs.twimg.com/media/inline.jpg", "media (not expanded): 3_9"],
      links: ["https://docs.x.com"],
      embedded_posts: ["https://x.com/i/web/status/1799000000000000001"],
      mentions: ["@mgcrea"],
      hashtags: ["#mcp"],
      body,
      body_chars: body.length,
    });
    const url = new URL(h.urls()[0] as string);
    expect(url.searchParams.get("tweet.fields")?.split(",")).toContain("article");
    expect(url.searchParams.get("expansions")).toContain("article.media_entities");
    expect(res.cost).toMatchObject({ billable_post_reads: 1 });
  });

  it("pages a long body out of the cache, issuing a single request", async () => {
    const response = structuredClone(ARTICLE_RESPONSE);
    (response.data[0] as { article: { plain_text: string } }).article.plain_text = "a".repeat(2500);
    const fetchMock = vi.fn(async () => jsonResponse(response));
    const h = await connect(undefined, fetchMock);

    const first = await h.call("x_get_article", { postId: ARTICLE_POST, maxChars: 1000 });
    expect(first.article.body).toHaveLength(1000);
    expect(first.article.next_offset).toBe(1000);

    const last = await h.call("x_get_article", {
      postId: ARTICLE_POST,
      offset: 2000,
      maxChars: 1000,
    });
    expect(last.article.body).toHaveLength(500);
    expect(last.article.next_offset).toBeUndefined();
    // The lists came with the first page; later pages carry only the text.
    expect(last.article).not.toHaveProperty("images");
    expect(last.cost).toMatchObject({ billable_post_reads: 0, free_from_cache: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // x_get_post caches a shape with no body under the same id. Serving that to
  // x_get_article would return an Article with nothing in it.
  it("does not serve the body-less post x_get_post cached as an Article", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ARTICLE_RESPONSE));
    const h = await connect(undefined, fetchMock);

    const post = await h.call("x_get_post", { postId: ARTICLE_POST });
    expect(post.post.article).toEqual({ title: "The late Software Developer" });
    expect(new URL(h.urls()[0] as string).searchParams.get("tweet.fields")).toContain(
      "article_title",
    );

    const res = await h.call("x_get_article", { postId: ARTICLE_POST });
    expect(res.article.body).toContain("It is exciting.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Still billed once: X does not charge a second read of a post in one UTC day.
    expect(res.cost).toMatchObject({ billable_post_reads: 0 });
  });

  it("says so when the post is not an Article", async () => {
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse({ data: [{ id: "1", text: "hi", author_id: "2" }] })),
    );
    const res = await h.call("x_get_article", { postId: "1" });
    expect(res.error).toMatch(/not an Article/);
  });
});

describe("x_compare_article", () => {
  it("reports the paragraphs that drifted, with the Markdown as the source", async () => {
    const response = {
      data: [
        {
          id: "9",
          author_id: "u",
          article: { title: "Title", plain_text: "Intro.\nOld wording.\n \nOutro." },
        },
      ],
      includes: { users: [{ id: "u", username: "mgcrea" }] },
    };
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse(response)),
    );
    const res = await h.call("x_compare_article", {
      postId: "9",
      markdown: "# Title\n\nIntro.\n\nNew wording.\n\n![x](/a.png)\n\nOutro.",
    });

    expect(res.in_sync).toBe(false);
    expect(res.title).toEqual({ same: true, text: "Title" });
    expect(res.changes).toEqual([
      { kind: "changed", after: "Intro.", source: "New wording.", x: "Old wording." },
    ]);
    expect(res.paragraphs).toEqual({ source: 3, x: 3, unchanged: 2 });
    expect(res.next_step).toMatch(/cannot edit/);
  });

  it("is in sync when only whitespace and quote style differ", async () => {
    const response = {
      data: [{ id: "9", article: { title: "It’s here", plain_text: "“Quoted” text." } }],
    };
    const h = await connect(
      undefined,
      vi.fn(async () => jsonResponse(response)),
    );
    const res = await h.call("x_compare_article", {
      postId: "9",
      markdown: '"Quoted"   text.',
      title: "It's here",
    });
    expect(res.in_sync).toBe(true);
    expect(res.changes_total).toBe(0);
  });

  it("fails on a bad markdownPath before spending a read", async () => {
    const h = await connect();
    const res = await h.call("x_compare_article", { postId: "9", markdownPath: "relative.md" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/absolute/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_validate_article", () => {
  it("previews the conversion with no credentials and no request", async () => {
    const h = await connect({}, undefined, { realAuth: true });
    const res = await h.call("x_validate_article", {
      markdown: "# Hello\n\n#### Deep\n\ntext with `code`",
    });
    expect(res).toMatchObject({ ready: true, title: "Hello", blocks: 2, outline: ["### Deep"] });
    expect(res.warnings).toHaveLength(2);
    expect(res.content_state).toBeUndefined();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("reports an image it could not upload as a problem, not a crash", async () => {
    const h = await connect({}, undefined, { realAuth: true });
    const res = await h.call("x_validate_article", { markdown: "# T\n\n![a](missing.png)" });
    expect(res.isToolError).toBe(false);
    expect(res.ready).toBe(false);
    expect(res.problems[0]).toMatch(/markdownPath/);
  });
});

describe("x_create_article_draft", () => {
  const writes = { X_CLIENT_ID: "c", X_ALLOW_WRITES: "1", X_WRITE_BACKEND: "api" };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const DRAFT_ID = "1146654567674912769";

  const routed = () =>
    vi.fn(async (url: string) => {
      if (String(url).includes("/2/media/upload")) return jsonResponse({ data: { id: "m-1" } });
      return jsonResponse({ data: { id: DRAFT_ID, title: "Hello" } }, { status: 201 });
    });

  it("uploads each distinct image once, fills every slot, and creates the draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x-draft-"));
    try {
      writeFileSync(join(dir, "shot.png"), PNG);
      writeFileSync(
        join(dir, "post.md"),
        "---\ntitle: Hello\n---\n\nIntro.\n\n![one](./shot.png)\n\n![again](shot.png)\n",
      );
      const fetchMock = routed();
      const h = await connect(writes, fetchMock);
      const res = await h.call("x_create_article_draft", {
        markdownPath: join(dir, "post.md"),
        coverImagePath: "shot.png",
        confirm: true,
      });

      expect(res).toMatchObject({
        drafted: true,
        article_id: DRAFT_ID,
        images_uploaded: 1,
        cover: "uploaded",
      });
      expect(h.urls().filter((u) => u.includes("/2/media/upload"))).toHaveLength(1);
      expect(JSON.parse(String(initOf(fetchMock, 0).body))).toEqual({
        media: PNG.toString("base64"),
        media_category: "tweet_image",
      });

      const draftCall = h.urls().findIndex((u) => u.includes("/2/articles/draft"));
      const body = JSON.parse(String(initOf(fetchMock, draftCall).body));
      const media = [{ media_id: "m-1", media_category: "tweet_image" }];
      expect(body.title).toBe("Hello");
      expect(body.cover_media).toEqual(media[0]);
      const images = body.content_state.entities.filter(
        (e: { value: { type: string } }) => e.value.type === "image",
      );
      expect(images.map((e: { value: { data: unknown } }) => e.value.data)).toEqual([
        { media_items: media },
        { media_items: media },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file that is not an image before sending anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x-draft-"));
    try {
      writeFileSync(join(dir, "id_ed25519.png"), "-----BEGIN OPENSSH PRIVATE KEY-----");
      const h = await connect(writes, routed());
      const res = await h.call("x_create_article_draft", {
        markdown: `# Hi\n\nBody\n\n![](${join(dir, "id_ed25519.png")})`,
        confirm: true,
      });
      expect(res.isToolError).toBe(true);
      expect(res.error).toMatch(/not a PNG, JPEG or WebP/);
      expect(h.fetchMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says to log in again when X refuses the upload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x-draft-"));
    try {
      writeFileSync(join(dir, "shot.png"), PNG);
      const h = await connect(
        writes,
        vi.fn(async () => jsonResponse({ title: "Forbidden", detail: "scope" }, { status: 403 })),
      );
      const res = await h.call("x_create_article_draft", {
        markdown: `# Hi\n\n![](${join(dir, "shot.png")})`,
        confirm: true,
      });
      expect(res.isToolError).toBe(true);
      expect(res.error).toMatch(/media\.write/);
      expect(res.error).toMatch(/x_login/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a draft with no title before any request", async () => {
    const h = await connect(writes, routed());
    const res = await h.call("x_create_article_draft", { markdown: "Just a body.", confirm: true });
    expect(res.isToolError).toBe(true);
    expect(res.error).toMatch(/No title/);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("requires confirm", async () => {
    const h = await connect(writes, routed());
    const res = await h.call("x_create_article_draft", { markdown: "# T\n\nBody" });
    expect(res.isToolError).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("x_publish_article", () => {
  it("publishes the draft and returns the post that carries it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { post_id: "1346889436626259968" } }));
    const h = await connect(
      { X_CLIENT_ID: "c", X_ALLOW_WRITES: "1", X_WRITE_BACKEND: "api" },
      fetchMock,
    );
    const res = await h.call("x_publish_article", {
      articleId: "1146654567674912769",
      confirm: true,
    });
    expect(res).toMatchObject({
      published: true,
      post_id: "1346889436626259968",
      url: "https://x.com/i/web/status/1346889436626259968",
    });
    expect(h.urls()[0]).toMatch(/\/2\/articles\/1146654567674912769\/publish$/);
    expect(initOf(fetchMock).method).toBe("POST");
  });
});

describe("media.write is asked for, not required", () => {
  // Requiring it would have treated every existing API-write login as no login
  // at all — reads included — until the user logged in again.
  it("keeps a stored write login signed in when it predates media.write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x-scopes-"));
    const tokenFile = join(dir, "tokens.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({
        version: 1,
        clientId: "cid",
        scopes: ["tweet.read", "users.read", "bookmark.read", "offline.access", "tweet.write"],
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
        obtainedAt: Date.now(),
        username: "mgcrea",
        userId: "1",
      }),
      { mode: 0o600 },
    );
    try {
      const h = await connect(
        {
          X_CLIENT_ID: "cid",
          X_TOKEN_FILE: tokenFile,
          X_ALLOW_WRITES: "1",
          X_WRITE_BACKEND: "api",
        },
        undefined,
        { realAuth: true },
      );
      expect((await h.call("x_get_auth_status")).signedIn).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ads analytics jobs", () => {
  const ADS = {
    X_BEARER_TOKEN: "t",
    X_CLIENT_ID: "c",
    X_ADS_ENABLED: "1",
    X_ADS_ACCOUNT_ID: "acct1",
  };

  it("lists jobs, counts the finished ones, and pairs money fields with major units", async () => {
    const h = await connect(
      ADS,
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id_str: "1", status: "SUCCESS", url: "https://ton.twimg.com/r/1.json.gz" },
            { id_str: "2", status: "PROCESSING" },
          ],
        }),
      ),
    );
    const res = await h.call("x_ads_get_stats_jobs", {});
    expect(res.ready_count).toBe(1);
    expect(res.jobs).toHaveLength(2);
    expect(res.note).toBeUndefined();
  });

  it("summarises a downloaded job per entity and converts billed charges", async () => {
    const { gzipSync } = await import("node:zlib");
    const report = {
      data: [
        {
          id: "camp1",
          id_data: [
            { metrics: { impressions: [10, 20], billed_charge_local_micro: [1_500_000, 500_000] } },
            { metrics: { impressions: [5], billed_charge_local_micro: [250_000] } },
          ],
        },
      ],
    };
    const h = await connect(
      ADS,
      vi.fn(
        async () => new Response(gzipSync(Buffer.from(JSON.stringify(report))), { status: 200 }),
      ),
    );
    const res = await h.call("x_ads_download_stats_job", {
      url: "https://ton.twimg.com/advertiser-api-async-analytics/1.json.gz",
    });
    expect(res.entities).toEqual([
      {
        id: "camp1",
        segments: 2,
        totals: { impressions: 35, billed_charge_local_micro: 2_250_000, billed_charge: 2.25 },
      },
    ]);
    expect(res.row_count).toBe(1);

    const raw = await h.call("x_ads_download_stats_job", {
      url: "https://ton.twimg.com/advertiser-api-async-analytics/1.json.gz",
      raw: true,
      maxRows: 1,
    });
    expect(raw.rows).toHaveLength(1);
    expect(raw.truncated).toBe(false);
  });

  it("shapes the synchronous stats so BILLING spend is readable", async () => {
    const h = await connect(
      ADS,
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "camp1", id_data: [{ metrics: { billed_charge_local_micro: [47_500_000] } }] },
          ],
        }),
      ),
    );
    const res = await h.call("x_ads_get_stats", {
      entity: "CAMPAIGN",
      entityIds: ["camp1"],
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-02T00:00:00Z",
      metricGroups: ["BILLING"],
    });
    // Metrics are one value per time bucket, so the paired field is a series too.
    expect(res.stats[0].id_data[0].metrics).toMatchObject({
      billed_charge_local_micro: [47_500_000],
      billed_charge: [47.5],
    });
  });

  it("pairs credit limits on funding instruments, not only *_amount_* fields", async () => {
    const h = await connect(
      ADS,
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: "fi1",
              credit_limit_local_micro: 10_000_000,
              credit_remaining_local_micro: 2_500_000,
            },
          ],
        }),
      ),
    );
    const res = await h.call("x_ads_get_funding_instruments", {});
    expect(res.funding_instruments[0]).toMatchObject({ credit_limit: 10, credit_remaining: 2.5 });
  });
});
