import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { userTokenProvider } from "#/client/auth";
import { UserContextRequiredError } from "#/client/errors";
import {
  buildAuthorizeUrl,
  createOAuthClient,
  createPkcePair,
  startLoginFlow,
  toStoredTokens,
  type OAuthClient,
} from "#/client/oauth";
import { createTokenStore, TOKEN_FILE_VERSION, tokensAreStale } from "#/client/tokens";
import { loadConfig } from "#/config";

let dir: string;
let tokenPath: string;
const ABSENT = "/nonexistent/config.json";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-oauth-"));
  tokenPath = join(dir, "tokens.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const storedTokens = (over: Partial<Record<string, unknown>> = {}) => ({
  version: TOKEN_FILE_VERSION,
  clientId: "cid",
  scopes: ["tweet.read", "users.read", "offline.access"],
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: Date.now() + 3_600_000,
  obtainedAt: Date.now(),
  userId: "44196397",
  username: "mgcrea",
  ...over,
});

describe("createPkcePair", () => {
  it("produces a 43-char verifier and a matching S256 challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);

    // Verify independently rather than trusting our own helper.
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("is different every time", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries every parameter X requires, with space-separated scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: "http://127.0.0.1:8723/callback",
        scopes: ["tweet.read", "users.read"],
        state: "st",
        challenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8723/callback");
    // Space-separated, unlike nearly everything else in the X API.
    expect(url.searchParams.get("scope")).toBe("tweet.read users.read");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("token store", () => {
  it("writes with mode 0600 so no other user can read the refresh token", () => {
    const store = createTokenStore(tokenPath);
    store.write(storedTokens() as never);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("round-trips", () => {
    const store = createTokenStore(tokenPath);
    const tokens = storedTokens();
    store.write(tokens as never);
    expect(store.read()).toEqual(tokens);
  });

  it("treats an absent file as unauthenticated rather than erroring", () => {
    expect(createTokenStore(join(dir, "missing.json")).read()).toBeUndefined();
  });

  it("treats a file from an unknown version as absent", () => {
    writeFileSync(tokenPath, JSON.stringify({ ...storedTokens(), version: 999 }));
    expect(createTokenStore(tokenPath).read()).toBeUndefined();
  });

  it("survives a corrupt file instead of crashing the server", () => {
    writeFileSync(tokenPath, "{ not json");
    expect(createTokenStore(tokenPath).read()).toBeUndefined();
  });

  it("clear() is idempotent", () => {
    const store = createTokenStore(tokenPath);
    store.write(storedTokens() as never);
    store.clear();
    expect(() => store.clear()).not.toThrow();
    expect(store.read()).toBeUndefined();
  });
});

describe("tokensAreStale", () => {
  it("invalidates tokens belonging to a different client id", () => {
    const res = tokensAreStale(storedTokens() as never, "other-cid", []);
    expect(res).toEqual({
      stale: true,
      reason: expect.stringMatching(/different X_CLIENT_ID/),
    });
  });

  it("catches a missing scope locally rather than letting X answer 403", () => {
    const res = tokensAreStale(storedTokens() as never, "cid", ["bookmark.read"]);
    expect(res).toEqual({ stale: true, reason: expect.stringMatching(/bookmark\.read/) });
  });

  it("accepts tokens that cover what is needed", () => {
    expect(tokensAreStale(storedTokens() as never, "cid", ["tweet.read"])).toEqual({
      stale: false,
    });
  });
});

const makeProvider = (oauth: OAuthClient, tokens = storedTokens()) => {
  const store = createTokenStore(tokenPath);
  store.write(tokens as never);
  return {
    store,
    provider: userTokenProvider({
      store,
      oauth,
      clientId: "cid",
      requiredScopes: ["tweet.read"],
    }),
  };
};

describe("userTokenProvider refresh rotation", () => {
  it("returns the cached token while it is still valid", async () => {
    const oauth = { exchangeCode: vi.fn(), refresh: vi.fn() } as unknown as OAuthClient;
    const { provider } = makeProvider(oauth);
    expect(await provider.getToken("user")).toBe("access-1");
    expect(oauth.refresh).not.toHaveBeenCalled();
  });

  it("refreshes when the token is within the expiry skew", async () => {
    const oauth = {
      exchangeCode: vi.fn(),
      refresh: vi.fn(async () => ({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 7200,
      })),
    } as unknown as OAuthClient;
    // 30s of life left, inside the 60s skew.
    const { provider } = makeProvider(oauth, storedTokens({ expiresAt: Date.now() + 30_000 }));
    expect(await provider.getToken("user")).toBe("access-2");
    expect(oauth.refresh).toHaveBeenCalledWith("refresh-1");
  });

  it("persists the rotated pair BEFORE handing the access token out", async () => {
    let diskAtHandout: unknown;
    const store = createTokenStore(tokenPath);
    store.write(storedTokens({ expiresAt: 0 }) as never);
    const provider = userTokenProvider({
      store,
      oauth: {
        exchangeCode: vi.fn(),
        refresh: async () => ({ access_token: "access-2", refresh_token: "refresh-2" }),
      } as unknown as OAuthClient,
      clientId: "cid",
      requiredScopes: [],
    });

    const token = await provider.getToken("user");
    diskAtHandout = store.read();
    expect(token).toBe("access-2");
    // The new refresh token is already durable — a crash here loses nothing.
    expect((diskAtHandout as { refreshToken: string }).refreshToken).toBe("refresh-2");
    expect((diskAtHandout as { previousRefreshToken: string }).previousRefreshToken).toBe(
      "refresh-1",
    );
  });

  it("retries once with the previous generation when the current token is rejected", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 400 — invalid_request"))
      .mockResolvedValueOnce({ access_token: "access-3", refresh_token: "refresh-3" });
    const { provider } = makeProvider(
      { exchangeCode: vi.fn(), refresh } as unknown as OAuthClient,
      storedTokens({ expiresAt: 0, refreshToken: "dead", previousRefreshToken: "refresh-0" }),
    );

    expect(await provider.getToken("user")).toBe("access-3");
    expect(refresh).toHaveBeenNthCalledWith(1, "dead");
    expect(refresh).toHaveBeenNthCalledWith(2, "refresh-0");
  });

  it("gives up with a login hint when both generations fail", async () => {
    const { provider } = makeProvider(
      {
        exchangeCode: vi.fn(),
        refresh: vi.fn(async () => {
          throw new Error("HTTP 400");
        }),
      } as unknown as OAuthClient,
      storedTokens({ expiresAt: 0 }),
    );
    await expect(provider.getToken("user")).rejects.toThrow(UserContextRequiredError);
    await expect(provider.getToken("user")).rejects.toThrow(/x-mcp login/);
  });

  it("issues exactly one refresh for concurrent callers", async () => {
    // Assigned by the refresh below before anything calls it.
    let resolveRefresh!: (v: unknown) => void;
    const refresh = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { provider } = makeProvider(
      { exchangeCode: vi.fn(), refresh } as unknown as OAuthClient,
      storedTokens({ expiresAt: 0 }),
    );

    const calls = [provider.getToken("user"), provider.getToken("user"), provider.getToken("user")];
    resolveRefresh({ access_token: "access-2", refresh_token: "refresh-2" });
    const results = await Promise.all(calls);

    // The second refresh would present a token the first had just invalidated.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results).toEqual(["access-2", "access-2", "access-2"]);
  });

  it("reports the reason when there are no stored tokens at all", async () => {
    const provider = userTokenProvider({
      store: createTokenStore(join(dir, "missing.json")),
      oauth: { exchangeCode: vi.fn(), refresh: vi.fn() } as unknown as OAuthClient,
      clientId: "cid",
      requiredScopes: [],
    });
    await expect(provider.getToken("user")).rejects.toThrow(/no stored tokens/);
    expect(provider.describe().user).toEqual({
      authenticated: false,
      reason: "no stored tokens",
    });
  });

  it("describes an authenticated session", () => {
    const { provider } = makeProvider({
      exchangeCode: vi.fn(),
      refresh: vi.fn(),
    } as unknown as OAuthClient);
    expect(provider.describe().user).toMatchObject({
      authenticated: true,
      username: "mgcrea",
      userId: "44196397",
    });
  });
});

describe("createOAuthClient", () => {
  const config = loadConfig({ X_CLIENT_ID: "cid", X_BASE_URL: "https://x.test" }, ABSENT);

  it("posts the code exchange form-encoded with the verifier", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "a" })));
    await createOAuthClient(config, f as unknown as typeof fetch).exchangeCode(
      "the-code",
      "the-verifier",
    );

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.test/2/oauth2/token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("client_id")).toBe("cid");
  });

  it("adds Basic auth only for a confidential client", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "a" })));
    const confidential = loadConfig(
      { X_CLIENT_ID: "cid", X_CLIENT_SECRET: "sec", X_BASE_URL: "https://x.test" },
      ABSENT,
    );
    await createOAuthClient(confidential, f as unknown as typeof fetch).refresh("r");
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("cid:sec").toString("base64")}`,
    );
  });

  it("surfaces X's own message when the exchange is rejected", async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    await expect(
      createOAuthClient(config, f as unknown as typeof fetch).refresh("r"),
    ).rejects.toThrow(/HTTP 400.*invalid_grant/);
  });
});

describe("toStoredTokens", () => {
  it("prefers the scopes X actually granted over the ones requested", () => {
    const tokens = toStoredTokens(
      { access_token: "a", scope: "tweet.read users.read" },
      { clientId: "cid", requestedScopes: ["tweet.read", "users.read", "bookmark.read"], now: 0 },
    );
    expect(tokens.scopes).toEqual(["tweet.read", "users.read"]);
  });

  it("defaults the lifetime conservatively when X does not state one", () => {
    const tokens = toStoredTokens(
      { access_token: "a" },
      { clientId: "c", requestedScopes: [], now: 0 },
    );
    expect(tokens.expiresAt).toBe(7200 * 1000);
  });
});

// Drive the callback the way a browser would, once the URL is known.
const openBrowser = async (authorizeUrl: string) => {
  const state = new URL(authorizeUrl).searchParams.get("state");
  await fetch(`http://127.0.0.1:8799/callback?code=the-code&state=${state}`);
  return { opened: true };
};

/** A "browser" whose callback carries a state the login flow never issued. */
const openBrowserForgedState = async () => {
  await fetch("http://127.0.0.1:8798/callback?code=c&state=forged");
  return { opened: true };
};

describe("startLoginFlow", () => {
  it("refuses without a client id, naming the callback URL to register", async () => {
    const config = loadConfig({ X_BEARER_TOKEN: "t" }, ABSENT);
    await expect(startLoginFlow({ config, store: createTokenStore(tokenPath) })).rejects.toThrow(
      /X_CLIENT_ID.*127\.0\.0\.1:8723\/callback/s,
    );
  });

  it("completes end to end against a real loopback callback", async () => {
    const config = loadConfig(
      {
        X_CLIENT_ID: "cid",
        X_BASE_URL: "https://x.test",
        X_REDIRECT_URI: "http://127.0.0.1:8799/callback",
      },
      ABSENT,
    );
    const store = createTokenStore(tokenPath);

    const f = vi.fn(async (url: string) => {
      if (String(url).endsWith("/2/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 7200,
            scope: "tweet.read users.read offline.access",
          }),
        );
      }
      return new Response(JSON.stringify({ data: { id: "44196397", username: "mgcrea" } }));
    });

    const { tokens } = await startLoginFlow({
      config,
      store,
      fetch: f as unknown as typeof fetch,
      openBrowser,
      timeoutMs: 5000,
    });

    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.username).toBe("mgcrea");
    expect(tokens.userId).toBe("44196397");
    expect(store.read()?.refreshToken).toBe("refresh-1");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("rejects a callback whose state does not match the login that started", async () => {
    const config = loadConfig(
      {
        X_CLIENT_ID: "cid",
        X_BASE_URL: "https://x.test",
        X_REDIRECT_URI: "http://127.0.0.1:8798/callback",
      },
      ABSENT,
    );
    await expect(
      startLoginFlow({
        config,
        store: createTokenStore(tokenPath),
        fetch: vi.fn() as unknown as typeof fetch,
        openBrowser: openBrowserForgedState,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/state mismatch/);
  });
});
