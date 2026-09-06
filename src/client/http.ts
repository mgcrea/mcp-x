import type { Logger } from "#/client/auth";
import { RequestTimeoutError } from "#/client/errors";

/**
 * How long one HTTP round trip may take before it is abandoned. A stalled
 * connection would otherwise hang the tool call forever: the MCP client gives
 * up on its side with no server-side cancellation, and the retry loop never
 * advances. Thirty seconds is well past anything X answers in normally.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The longest a 429 or 5xx is waited out inside a tool call. X's v2 windows
 * are 15 minutes and `Retry-After` says so honestly; sleeping for it would look
 * exactly like a hung server, and could stack to `maxRetries` × 15 min. Past
 * this the 429 is returned at once with the reset time in its message.
 */
export const MAX_RETRY_WAIT_MS = 30_000;

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

/**
 * What the last response told us about how much of an endpoint's budget is left.
 *
 * `scope` and `api` are optional because the v2 API reports exactly one family
 * of rate-limit headers and has no need to distinguish them. The Ads API
 * reports three (endpoint, account and cost), so it fills them in.
 */
export type RateLimitSnapshot = {
  endpoint: string;
  limit?: number;
  remaining?: number;
  /** Unix seconds, as X reports it. */
  reset?: number;
  resetAt?: string;
  scope?: "endpoint" | "account" | "cost";
  api?: "v2" | "ads";
};

/** Anything that can report rate limits, so a tool can merge several clients. */
export type RateLimitReporter = {
  rateLimitStatus(): RateLimitSnapshot[];
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response, now: number = Date.now()): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000;
  }
  // X rarely sends Retry-After; it reports the window end as unix seconds.
  const reset = numberOrUndefined(res.headers.get("x-rate-limit-reset"));
  if (reset !== undefined) return Math.max(reset * 1000 - now, 0);
  return undefined;
};

/**
 * `fetch` with a deadline, and the abort translated into an error that names
 * the request rather than a bare "This operation was aborted".
 */
export const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> => {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new RequestTimeoutError(label, timeoutMs);
    }
    throw err;
  }
};

export const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

export const numberOrUndefined = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * X takes comma-separated lists for both field selection
 * (`tweet.fields=id,text,created_at`) and batch lookups (`ids=1,2,3`) — not
 * repeated keys. Same join as JSON:API happens to need, different reason.
 */
export const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.append(key, value.join(","));
      continue;
    }
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

/**
 * Collapse a concrete path to the shape X documents its rate limits against, so
 * `/2/tweets/1799…` and `/2/tweets/1798…` share one bucket instead of leaking a
 * new entry per post.
 */
export const endpointKey = (method: string, path: string): string =>
  `${method} ${path
    .replace(/\/\d{5,}/g, "/:id")
    // Handles are not digits, and without this every profile looked up by
    // name is its own bucket — a map that grows for the life of the process.
    .replace(/\/by\/username\/[^/?]+/, "/by/username/:username")
    .replace(/\?.*$/, "")}`;

export type RetryPolicy = {
  maxRetries: number;
  label: string;
  logger?: Logger | undefined;
  /**
   * Called on a 401. Returns whether the next attempt will carry a different
   * credential; `false` ends the retries, because re-sending the same rejected
   * token `maxRetries` times only burns the budget and the user's time.
   */
  onUnauthorized?: (() => boolean | void) | undefined;
  maxWaitMs?: number | undefined;
};

/** Run `perform` until it yields a non-retryable response or the budget runs out. */
export const withRetry = async (
  perform: () => Promise<Response>,
  policy: RetryPolicy,
): Promise<Response> => {
  let attempt = 0;
  const maxWait = policy.maxWaitMs ?? MAX_RETRY_WAIT_MS;

  for (;;) {
    policy.logger?.debug?.(`[x] ${policy.label} (attempt ${attempt + 1})`);
    const res = await perform();

    if (res.status === 401 && policy.onUnauthorized && attempt < policy.maxRetries) {
      if (policy.onUnauthorized() === false) return res;
      policy.logger?.warn?.(`[x] HTTP 401 — refreshing token and retrying`);
      attempt += 1;
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < policy.maxRetries) {
      const delay = retryAfterMs(res) ?? backoffMs(attempt);
      if (delay > maxWait) {
        policy.logger?.warn?.(
          `[x] HTTP ${res.status} — the window resets in ${Math.round(delay / 1000)}s, not waiting`,
        );
        return res;
      }
      policy.logger?.warn?.(`[x] HTTP ${res.status} — retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
      continue;
    }

    return res;
  }
};
