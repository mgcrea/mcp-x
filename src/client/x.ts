import type { AuthContext, Logger, TokenProvider } from "#/client/auth";
import { type XApiError, XApiRequestError } from "#/client/errors";
import {
  buildQuery,
  DEFAULT_REQUEST_TIMEOUT_MS,
  endpointKey,
  fetchWithTimeout,
  numberOrUndefined,
  safeJsonParse,
  withRetry,
  type Query,
  type RateLimitSnapshot,
} from "#/client/http";
import { DEFAULT_BASE_URL } from "#/config";

// Re-exported so the many call sites that import these from `./x.js` keep
// working; the definitions moved to `./http.js` when the Ads client needed them.
export type { Query, QueryValue, RateLimitSnapshot } from "#/client/http";

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  /** Which credential to send. Defaults to the app-only Bearer token. */
  auth?: AuthContext;
};

export type XApiClientOptions = {
  baseUrl?: string;
  tokenProvider: TokenProvider;
  maxRetries?: number;
  /** Deadline per HTTP round trip. See DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
};

/**
 * Minimal fetch-based client for the X API v2. Paths are absolute (`/2/tweets`).
 * Retries a 401 (invalidating the token first) and 429/5xx with exponential
 * backoff honoring `Retry-After`, and records every response's rate-limit
 * headers so a 429 can say what it is waiting for.
 */
export class XApiClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;
  private readonly rateLimits = new Map<string, RateLimitSnapshot>();

  constructor(opts: XApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.tokenProvider = opts.tokenProvider;
    this.maxRetries = opts.maxRetries ?? 3;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? "mcp-x-js";
  }

  /** Everything the last response said about each endpoint's remaining budget. */
  rateLimitStatus(): RateLimitSnapshot[] {
    return [...this.rateLimits.values()];
  }

  private recordRateLimit(method: string, path: string, res: Response): void {
    const limit = numberOrUndefined(res.headers.get("x-rate-limit-limit"));
    const remaining = numberOrUndefined(res.headers.get("x-rate-limit-remaining"));
    const reset = numberOrUndefined(res.headers.get("x-rate-limit-reset"));
    if (limit === undefined && remaining === undefined && reset === undefined) return;
    const endpoint = endpointKey(method, path);
    this.rateLimits.set(endpoint, {
      endpoint,
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(reset !== undefined ? { reset, resetAt: new Date(reset * 1000).toISOString() } : {}),
    });
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const hasBody = opts.body !== undefined;
    const auth: AuthContext = opts.auth ?? "app";

    const res = await withRetry(
      async () => {
        const token = await this.tokenProvider.getToken(auth);
        return fetchWithTimeout(
          this.fetchImpl,
          url,
          {
            method,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "User-Agent": this.userAgent,
              ...(hasBody ? { "Content-Type": "application/json" } : {}),
            },
            ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
          },
          this.requestTimeoutMs,
          `X API ${method} ${path}`,
        );
      },
      {
        maxRetries: this.maxRetries,
        label: `${method} ${url}`,
        logger: this.logger,
        onUnauthorized: () => this.tokenProvider.invalidate(auth),
      },
    );

    this.recordRateLimit(method, path, res);
    const text = await res.text();

    if (!res.ok) {
      throw new XApiRequestError(this.errorMessage(res, method, path, text), {
        status: res.status,
        errors: this.parseErrors(text),
      });
    }

    if (res.status === 204 || text.trim() === "") return null as T;
    return safeJsonParse(text) as T;
  }

  get<T = unknown>(path: string, query?: Query, auth: AuthContext = "app"): Promise<T> {
    return this.request<T>("GET", path, { query, auth });
  }

  post<T = unknown>(path: string, body?: unknown, auth: AuthContext = "user"): Promise<T> {
    return this.request<T>("POST", path, { body, auth });
  }

  del<T = unknown>(path: string, auth: AuthContext = "user"): Promise<T> {
    return this.request<T>("DELETE", path, { auth });
  }

  /**
   * GET a collection, following `meta.next_token` until the pages run out or a
   * bound is hit.
   *
   * Both bounds exist because unbounded pagination here spends real money: at
   * $0.005 a post, walking a busy hashtag to the end is a three-figure mistake
   * an agent can make in one call. `maxItems` is the one callers actually set.
   *
   * `maxItems` decides when to stop asking for pages — it never trims what came
   * back. X floors `max_results` at 10 (5 on timelines) and bills every post it
   * returns, so a caller who asked for 3 has already paid for 10: trimming would
   * throw away bought data, and the `nextToken` handed back would then skip the
   * trimmed posts on the following page, silently. Everything fetched is
   * returned and it is the caller's job to bill all of it.
   *
   * X carries the cursor in `meta.next_token` and expects it back as
   * `pagination_token`, so — unlike a `links.next` API — the original query has
   * to be re-sent on every page rather than replaced. Per-id `errors` (a deleted
   * post in the middle of a page arrives as a 200 with a footnote) are collected
   * across pages too, so the shaping layer can report `not_found`.
   */
  async paginate<T = unknown>(
    path: string,
    query: Query,
    opts: { maxItems: number; maxPages?: number; auth?: AuthContext },
  ): Promise<{ data: T[]; pages: number; nextToken?: string; includes: Rec[]; errors: unknown[] }> {
    type Envelope = {
      data?: T[];
      includes?: Rec;
      errors?: unknown[];
      meta?: { next_token?: unknown };
    };
    const maxPages = opts.maxPages ?? 10;
    const collected: T[] = [];
    const includes: Rec[] = [];
    const errors: unknown[] = [];
    let token: string | undefined;
    let pages = 0;
    let nextToken: string | undefined;

    for (;;) {
      const res: Envelope = await this.request<Envelope>("GET", path, {
        query: { ...query, ...(token ? { pagination_token: token } : {}) },
        ...(opts.auth ? { auth: opts.auth } : {}),
      });
      pages += 1;
      if (Array.isArray(res?.data)) collected.push(...res.data);
      if (res?.includes) includes.push(res.includes);
      if (Array.isArray(res?.errors)) errors.push(...res.errors);

      const next = res?.meta?.next_token;
      token = typeof next === "string" && next ? next : undefined;
      nextToken = token;

      if (!token || collected.length >= opts.maxItems || pages >= maxPages) break;
    }

    return {
      data: collected,
      pages,
      ...(nextToken ? { nextToken } : {}),
      includes,
      errors,
    };
  }

  private parseErrors(text: string): XApiError[] | unknown {
    const parsed = safeJsonParse(text);
    if (parsed && typeof parsed === "object" && "errors" in parsed) {
      return (parsed as { errors: XApiError[] }).errors;
    }
    return parsed;
  }

  /**
   * The three statuses that actually happen get a sentence naming the fix. A
   * bare "HTTP 403" sends people to the wrong place — usually to re-check a
   * token that was fine, when the real answer is that their access tier does
   * not include the endpoint.
   */
  private errorMessage(res: Response, method: string, path: string, text: string): string {
    const base = `X API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim();
    const parsed = this.parseErrors(text);
    const detail = Array.isArray(parsed)
      ? parsed
          .map((e: XApiError) => [e.title, e.detail ?? e.message].filter(Boolean).join(" — "))
          .filter(Boolean)
          .join("; ")
      : this.problemDetail(parsed);

    if (res.status === 401) {
      return (
        `${base} — the token was rejected. Check X_BEARER_TOKEN, or re-run ` +
        `\`x-mcp login\` if this call needed a user context` +
        (detail ? ` (${detail})` : "")
      );
    }
    if (res.status === 403) {
      // Ordered by what actually causes this. An app left in the legacy
      // Free/Development state authenticates fine and then 403s on every
      // user-context call, which reads as a scope problem and is not one —
      // sending people to re-check scopes here wastes a lot of their time.
      return (
        `${base} — authenticated, but the request was refused. Most often this means the app is ` +
        `not enrolled: at console.x.com open the app, and make sure it is in the Pay-per-use ` +
        `package and the Production environment (a "client-not-enrolled" or "client-forbidden" ` +
        `detail below confirms this). Otherwise, your access tier or this token's scopes do not ` +
        `cover the endpoint — full-archive search needs a paid tier, bookmarks need bookmark.read` +
        (detail ? ` (${detail})` : "")
      );
    }
    if (res.status === 429) {
      const snapshot = this.rateLimits.get(endpointKey(method, path));
      const window = snapshot
        ? ` (${snapshot.remaining ?? 0}/${snapshot.limit ?? "?"} remaining` +
          (snapshot.resetAt ? `, resets ${snapshot.resetAt}` : "") +
          `)`
        : "";
      return `${base} — rate limited${window}. Wait for the window to reset, or lower maxResults.`;
    }
    return base + (detail ? ` — ${detail}` : "");
  }

  private problemDetail(parsed: unknown): string {
    if (!parsed || typeof parsed !== "object") return "";
    const p = parsed as XApiError;
    return [p.title, p.detail].filter(Boolean).join(" — ");
  }
}

type Rec = Record<string, unknown>;
