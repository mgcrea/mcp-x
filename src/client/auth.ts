import { UserContextRequiredError } from "#/client/errors";
import type { OAuthClient } from "#/client/oauth";
import { toStoredTokens } from "#/client/oauth";
import type { StoredTokens, TokenStore } from "#/client/tokens";
import { tokensAreStale } from "#/client/tokens";
import type { Logger } from "#/logger";

export type { Logger } from "#/logger";

/**
 * X has two credentials that are not interchangeable, so every request has to
 * say which one it wants:
 *
 * - `"app"` — the app-only Bearer token. Reaches everything public: post
 *   lookup, search, user profiles, user timelines.
 * - `"user"` — an OAuth2 access token for a logged-in account. The only way to
 *   reach bookmarks and the home timeline, and the only way to write.
 *
 * This is the one place the shape diverges from a single-credential API: the
 * token provider is asked for a context rather than just "the token".
 */
export type AuthContext = "app" | "user";

export type UserAuthStatus =
  | { authenticated: false; reason: string }
  | {
      authenticated: true;
      username?: string;
      userId?: string;
      scopes: string[];
      expiresAt: number;
    };

export type AuthStatus = {
  app: boolean;
  user: UserAuthStatus;
};

export type TokenProvider = {
  /** Bearer value for the requested context. Throws `UserContextRequiredError` if unavailable. */
  getToken(context: AuthContext): Promise<string>;
  /**
   * Called on a 401 to force the next call to remint or refresh. Returns
   * whether that is possible at all: an app-only Bearer token cannot be
   * reminted, and saying so lets the retry loop stop instead of re-sending
   * the same rejected string.
   */
  invalidate(context: AuthContext): boolean;
  /** Powers `x_get_auth_status` and the startup banner. */
  describe(): AuthStatus;
};

/**
 * The app-only Bearer token, copied from the developer portal. It never
 * expires and cannot be reminted, so `invalidate` is a no-op: a 401 here means
 * the token is wrong, and retrying with the same string would only burn the
 * retry budget.
 */
export const bearerTokenProvider = (token: string): TokenProvider => ({
  getToken: async (context) => {
    if (context === "user") {
      throw new UserContextRequiredError(
        "This tool",
        "only an app-only Bearer token is configured",
      );
    }
    return token;
  },
  invalidate: () => false,
  describe: () => ({
    app: true,
    user: { authenticated: false, reason: "no OAuth2 client id configured" },
  }),
});

/**
 * An OAuth2 user token, refreshed on demand.
 *
 * Two rules make this safe against X's rotating refresh tokens, which are
 * invalidated the instant a refresh succeeds:
 *
 *  1. **Persist before use.** The new pair is written to disk before the access
 *     token is handed to the caller. Handing it out first and then crashing
 *     leaves the on-disk refresh token already dead, forcing a re-login.
 *  2. **Keep one generation.** A refresh that fails on the current token is
 *     retried once with `previousRefreshToken`, which recovers exactly the
 *     crash-between-response-and-write window rather than dumping the user back
 *     into a browser.
 *
 * A single in-flight promise coordinates concurrent callers, whichever context
 * they ask for: unlike a locally signed JWT, an OAuth refresh is a network call
 * that must not be issued twice — the second would present a token the first
 * had just invalidated.
 */
export const userTokenProvider = (opts: {
  store: TokenStore;
  oauth: OAuthClient;
  clientId: string;
  requiredScopes: string[];
  logger?: Logger | undefined;
  now?: () => number;
}): TokenProvider => {
  const now = opts.now ?? Date.now;
  /** Refresh a minute early, so a token cannot expire mid-flight. */
  const SKEW_MS = 60_000;
  let inFlight: Promise<string> | undefined;

  const refresh = async (tokens: StoredTokens): Promise<string> => {
    const candidates = [tokens.refreshToken, tokens.previousRefreshToken].filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (candidates.length === 0) {
      throw new UserContextRequiredError(
        "This tool",
        "the stored token has expired and carries no refresh token — the `offline.access` " +
          "scope was probably not granted",
      );
    }

    let lastError: unknown;
    for (const [index, candidate] of candidates.entries()) {
      try {
        const res = await opts.oauth.refresh(candidate);
        const next = toStoredTokens(res, {
          clientId: opts.clientId,
          requestedScopes: tokens.scopes,
          now: now(),
          previousRefreshToken: candidate,
          ...(tokens.userId ? { userId: tokens.userId } : {}),
          ...(tokens.username ? { username: tokens.username } : {}),
        });
        // Rule 1: on disk before it is used.
        opts.store.write(next);
        return next.accessToken;
      } catch (err) {
        lastError = err;
        if (index === 0 && candidates.length > 1) {
          opts.logger?.warn?.(
            "[x] refresh failed on the current token; retrying with the previous generation",
          );
        }
      }
    }
    throw new UserContextRequiredError(
      "This tool",
      `refreshing the stored token failed (${lastError instanceof Error ? lastError.message : String(lastError)})`,
    );
  };

  const resolve = async (): Promise<string> => {
    const tokens = opts.store.read();
    const staleness = tokensAreStale(tokens, opts.clientId, opts.requiredScopes);
    if (staleness.stale) throw new UserContextRequiredError("This tool", staleness.reason);

    const current = tokens as StoredTokens;
    if (current.expiresAt - SKEW_MS > now()) return current.accessToken;
    return refresh(current);
  };

  return {
    // An OAuth2 user token can read everything an app-only token can, so
    // serving app-context reads from it is correct, not a fallback hack — and
    // both contexts share the one in-flight refresh.
    getToken: async () => {
      if (!inFlight) {
        inFlight = resolve().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
    invalidate: () => {
      // Force the next call to refresh by expiring the cached copy on disk.
      const tokens = opts.store.read();
      if (tokens) opts.store.write({ ...tokens, expiresAt: 0 });
      inFlight = undefined;
      return true;
    },
    describe: () => {
      const tokens = opts.store.read();
      const staleness = tokensAreStale(tokens, opts.clientId, opts.requiredScopes);
      if (staleness.stale) {
        return { app: false, user: { authenticated: false, reason: staleness.reason } };
      }
      const current = tokens as StoredTokens;
      return {
        app: false,
        user: {
          authenticated: true,
          ...(current.username ? { username: current.username } : {}),
          ...(current.userId ? { userId: current.userId } : {}),
          scopes: current.scopes,
          expiresAt: current.expiresAt,
        },
      };
    },
  };
};

/**
 * Combine whichever providers are configured, dispatching by context. Either
 * side may be absent — a Bearer-only install is the common case, and a
 * user-only install is legitimate too (an OAuth2 access token can read
 * everything an app-only token can).
 */
export const compositeTokenProvider = (parts: {
  app?: TokenProvider;
  user?: TokenProvider;
}): TokenProvider => ({
  getToken: async (context) => {
    if (context === "user") {
      if (!parts.user) {
        throw new UserContextRequiredError("This tool", "no OAuth2 client id is configured");
      }
      return parts.user.getToken("user");
    }
    // Public reads work with either credential, so fall back to the user token
    // rather than failing when only OAuth2 is set up.
    if (parts.app) return parts.app.getToken("app");
    if (parts.user) return parts.user.getToken("user");
    throw new Error(
      "No credentials configured. Set X_BEARER_TOKEN, or X_CLIENT_ID and run " + "`x-mcp login`.",
    );
  },
  invalidate: (context) => {
    if (context === "user") return parts.user?.invalidate("user") ?? false;
    // Mirror of getToken: app-context reads served by the user token are
    // invalidated there, and a Bearer token cannot be invalidated at all.
    if (parts.app) return parts.app.invalidate("app");
    return parts.user?.invalidate("user") ?? false;
  },
  describe: () => ({
    app: parts.app?.describe().app ?? false,
    user: parts.user?.describe().user ?? {
      authenticated: false,
      reason: "no OAuth2 client id configured",
    },
  }),
});

/** The test double: one token, both contexts, no network. */
export const staticTokenProvider = (token: string): TokenProvider => ({
  getToken: async () => token,
  invalidate: () => true,
  describe: () => ({
    app: true,
    user: { authenticated: true, username: "test", userId: "1", scopes: [], expiresAt: 0 },
  }),
});
