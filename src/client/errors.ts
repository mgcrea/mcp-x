/**
 * X answers errors in two shapes depending on the endpoint: a problem-details
 * object (`{ title, detail, status, type }`) on v2, and a legacy
 * `{ errors: [{ message, code }] }` on a few others. Both are modelled here so
 * the client can quote whichever it got.
 */
export type XApiError = {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  message?: string;
  code?: number | string;
  /** Ads application errors carry the offending field here. */
  details?: unknown;
  /** Present on partial responses, e.g. one deleted post in a batch lookup. */
  resource_type?: string;
  parameter?: string;
  value?: string;
};

export class XApiRequestError extends Error {
  override readonly name = "XApiRequestError";
  readonly status: number;
  readonly errors: XApiError[] | unknown;

  constructor(message: string, opts: { status: number; errors?: XApiError[] | unknown }) {
    super(message);
    this.status = opts.status;
    this.errors = opts.errors;
  }
}

/**
 * Thrown when a tool needs a logged-in user and only an app-only Bearer token
 * is available. The message carries the fix, because "401 Unauthorized" tells
 * you nothing about which of two credentials was missing.
 */
export class UserContextRequiredError extends Error {
  override readonly name = "UserContextRequiredError";

  constructor(what: string, reason?: string) {
    super(
      `${what} needs an OAuth2 user context — an app-only Bearer token cannot reach it. ` +
        `Set X_CLIENT_ID and run \`x-mcp login\` once (it opens a browser and stores a ` +
        `refresh token in your config directory with mode 600), then retry.` +
        (reason ? ` (${reason})` : ""),
    );
  }
}

/**
 * Thrown when the Ads API is reachable but this account cannot use it — no Ads
 * entitlement on the app, or no ads account behind the logged-in user. Separate
 * from `UserContextRequiredError` because logging in again does not fix it: the
 * missing piece is an approval, not a token.
 */
export class AdsAccessError extends Error {
  override readonly name = "AdsAccessError";
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

/**
 * A local guard that fires *before* the request goes out, so an agent in a loop
 * cannot spend past the ceiling. Carries the arithmetic so the number is
 * auditable rather than mysterious.
 */
export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";
  readonly details: Record<string, unknown>;

  constructor(opts: { estimateUsd: number; spentUsd: number; limitUsd: number; what: string }) {
    super(
      `${opts.what} would cost about $${opts.estimateUsd.toFixed(3)}, which takes this session ` +
        `past the $${opts.limitUsd.toFixed(2)} budget (about $${opts.spentUsd.toFixed(3)} spent ` +
        `so far). Raise or unset X_MONTHLY_BUDGET_USD, or ask for fewer results.`,
    );
    this.details = { ...opts };
  }
}

/**
 * A local check that failed before we sent anything to X. Carries the state it
 * read, so the caller sees why rather than just that something was wrong.
 */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

/**
 * The upstream did not answer within the client's deadline. Separate from
 * `XApiRequestError` because there is no status to quote and no envelope to
 * parse — the fix is to retry later, or to narrow the request.
 */
export class RequestTimeoutError extends Error {
  override readonly name = "RequestTimeoutError";
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(
      `${label} did not answer within ${Math.round(timeoutMs / 1000)}s. X may be slow or ` +
        `unreachable; retry in a moment, or ask for fewer results.`,
    );
    this.timeoutMs = timeoutMs;
  }
}
