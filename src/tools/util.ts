import { z } from "zod";

import type { CacheKind, DayCache, ResourceKind } from "#/client/cache";
import type { CostNote, Ledger } from "#/client/cost";
import {
  BudgetExceededError,
  PreconditionError,
  UserContextRequiredError,
  XApiRequestError,
} from "#/client/errors";
import { shapePaginatedPosts, type PostPage } from "#/client/shape";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds 19-41% to every response — worst
 * on wide lists of short-keyed objects, which are exactly the replies already
 * big enough to hurt. No model needs the indentation, and every tool returns
 * through here. Files written to disk for humans stay pretty.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }),
    },
  ],
  isError: true,
});

/** Render a thrown value as a tool error, preserving X's own detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof XApiRequestError) {
    return fail(err.message, { status: err.status, errors: err.errors });
  }
  if (err instanceof BudgetExceededError || err instanceof PreconditionError) {
    return fail(err.message, err.details);
  }
  if (err instanceof UserContextRequiredError) {
    return fail(err.message);
  }
  if (err instanceof Error) {
    const details = (err as Error & { details?: unknown }).details;
    return fail(err.message, details);
  }
  return fail("Unknown error", err);
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/**
 * Every read tool takes this. `maxResults` defaults low and says why in its
 * own description — an agent that reads the schema learns the cost model
 * without anyone having to document it elsewhere. A factory rather than a
 * constant so `X_DEFAULT_MAX_RESULTS` actually reaches the schema.
 */
export const maxResultsArg = (defaultValue: number = 10) =>
  z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(defaultValue)
    .describe(
      `How many results to return (1-100). Defaults to ${defaultValue} because X bills about ` +
        "$0.005 per post read, so 100 results costs roughly $0.50. Raise it deliberately. X " +
        "floors a page at 10 (5 on timelines) and bills every post it returns, so asking for " +
        "fewer than that still costs the floor — the extra posts are returned rather than wasted.",
    );

export const postIdArg = z
  .string()
  .regex(/^\d+$/, "A post id is digits only — the number at the end of a post's URL.")
  .describe('A post (tweet) id: the digits ending its URL, e.g. "1799000000000000001".');

export const usernameArg = z
  .string()
  .regex(/^@?[A-Za-z0-9_]{1,15}$/, "An X handle is 1-15 characters of letters, digits or _.")
  .describe('An X handle, with or without the leading @, e.g. "mgcrea".');

export const userIdArg = z
  .string()
  .regex(/^\d+$/)
  .describe('A numeric X user id, e.g. "44196397". Prefer `username` unless you already have one.');

export const paginationTokenArg = z
  .string()
  .min(1)
  .optional()
  .describe("The `next_token` from a previous call, to fetch the following page.");

export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this posts to X and costs money.");

/** Drop undefined values so we never send `{"tweet.fields": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

export const stripAt = (handle: string): string =>
  handle.startsWith("@") ? handle.slice(1) : handle;

/**
 * The expansions and field sets every post read asks for. Kept in one place
 * because the shaping layer's output is only as good as what was requested —
 * omitting `author_id` here silently degrades every post to "@unknown".
 */
export const POST_QUERY = {
  expansions: [
    "author_id",
    "referenced_tweets.id",
    "referenced_tweets.id.author_id",
    "attachments.media_keys",
  ],
  "tweet.fields": [
    "created_at",
    "public_metrics",
    "entities",
    "conversation_id",
    "lang",
    "referenced_tweets",
    // Without this, `text` comes back capped at 280 characters and a 25,000
    // character post is served as its own first paragraph. A field on a read
    // already being paid for, not a second read, so it costs nothing.
    "note_tweet",
    // An Article post's own `text` is a bare t.co link, so without this it
    // reads as a link to nowhere in particular. `article_title` returns
    // `article: { title }` and nothing else — NOT `article`, which would pull
    // a body that runs past 50,000 characters into every search page just to
    // be shaped away. x_get_article asks for the body when it is wanted.
    "article_title",
  ],
  "user.fields": ["username", "name", "verified"],
  "media.fields": ["type", "url", "preview_image_url", "alt_text"],
};

export const USER_QUERY = {
  "user.fields": [
    "description",
    "public_metrics",
    "verified",
    "created_at",
    "location",
    "protected",
  ],
};

export type ToolDeps = {
  cache: DayCache;
  ledger: Ledger;
  budgetUsd?: number | undefined;
};

/**
 * Guard a read against the configured budget *before* issuing it, so a runaway
 * agent cannot discover the ceiling by crossing it.
 */
export const assertWithinBudget = (deps: ToolDeps, what: string, estimateUsd: number): void => {
  if (deps.budgetUsd === undefined) return;
  const spent = deps.ledger.spentUsd();
  if (spent + estimateUsd > deps.budgetUsd) {
    throw new BudgetExceededError({
      estimateUsd,
      spentUsd: spent,
      limitUsd: deps.budgetUsd,
      what,
    });
  }
};

/**
 * Serve whatever today's cache already holds and fetch only the rest.
 *
 * This mirrors X's own billing rule rather than merely optimizing: within one
 * UTC day the cached ids would not have been billed again anyway, so a hit is
 * genuinely free rather than just fast.
 */
export const cachedByIds = async <T>(
  deps: ToolDeps,
  kind: ResourceKind,
  ids: string[],
  fetchMissing: (missing: string[]) => Promise<Map<string, T>>,
  label: string,
  /** Cache under a different key than the one billed, when the shape differs. See `CacheKind`. */
  cacheKind: CacheKind = kind,
): Promise<{ items: T[]; cost: CostNote; notFound: string[] }> => {
  const cached = new Map<string, T>();
  const missing: string[] = [];
  let billed = 0;
  let freeFromLedger = 0;
  for (const id of ids) {
    const hit = deps.cache.get(cacheKind, id) as T | undefined;
    if (hit !== undefined) cached.set(id, hit);
    else missing.push(id);
  }

  if (missing.length > 0) {
    assertWithinBudget(deps, label, deps.ledger.estimate(kind, missing));
    const fetched = await fetchMissing(missing);
    for (const [id, item] of fetched) {
      deps.cache.set(cacheKind, id, item);
      cached.set(id, item);
    }
    // Bill only what came back: X does not charge for an id it could not serve.
    // The ledger's verdict is the one reported, not "was it a cache miss": the
    // cache is LRU-bounded and the ledger is not, so an id paid for this
    // morning and since evicted is a miss here but still free at X.
    const verdict = deps.ledger.record(kind, [...fetched.keys()]);
    billed = verdict.billable.length;
    freeFromLedger = verdict.free.length;
  }

  const items: T[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const item = cached.get(id);
    if (item !== undefined) items.push(item);
    else notFound.push(id);
  }

  const free = ids.length - missing.length + freeFromLedger;
  return {
    items,
    cost: buildCostNote(kind, billed, free, deps),
    notFound,
  };
};

const buildCostNote = (
  kind: ResourceKind,
  billable: number,
  free: number,
  deps: ToolDeps,
): CostNote => {
  const usd = deps.ledger.estimateCount(kind, billable);
  const field =
    kind === "post"
      ? "billable_post_reads"
      : kind === "user"
        ? "billable_user_reads"
        : "owned_reads";
  return {
    [field]: billable,
    free_from_cache: free,
    estimated_usd: Math.round(usd * 1000) / 1000,
    ...(free > 0
      ? { note: `${free} already read today — X does not bill those again until UTC midnight.` }
      : {}),
  } as CostNote;
};

/** Record the cost of a read whose ids were only known after the fact (searches). */
export const recordResultCost = (deps: ToolDeps, kind: ResourceKind, ids: string[]): CostNote => {
  const { billable, free } = deps.ledger.record(kind, ids);
  return buildCostNote(kind, billable.length, free.length, deps);
};

/**
 * Shape and bill everything a paginated post read brought back.
 *
 * Nothing is trimmed to `maxResults` here, on purpose. X floors `max_results`
 * at 10 (5 on timelines) and bills every post it returns, so a caller who asked
 * for 3 has paid for 10: returning the other 7 costs nothing, dropping them
 * wastes what was bought, and billing only 3 under-reports the spend. Includes
 * are merged across pages, so a page-two author resolves.
 */
export const finishPostPage = (
  deps: ToolDeps,
  kind: ResourceKind,
  page: PostPage,
): {
  posts: ReturnType<typeof shapePaginatedPosts>["posts"];
  result_count: number;
  next_token?: string;
  not_found?: string[];
  cost: CostNote;
} => {
  const shaped = shapePaginatedPosts(page);
  return {
    posts: shaped.posts,
    result_count: shaped.posts.length,
    ...(shaped.next_token ? { next_token: shaped.next_token } : {}),
    ...(shaped.not_found ? { not_found: shaped.not_found } : {}),
    cost: recordResultCost(
      deps,
      kind,
      shaped.posts.map((p) => p.id),
    ),
  };
};

/** Combine the cost notes of two reads made by one tool call. */
export const mergeCostNotes = (a: CostNote, b: CostNote): CostNote => {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = (a as Record<string, unknown>)[key];
    const right = (b as Record<string, unknown>)[key];
    if (typeof left === "number" || typeof right === "number") {
      out[key] =
        Math.round(((left as number) ?? 0) * 1000 + ((right as number) ?? 0) * 1000) / 1000;
    } else {
      const notes = [left, right].filter((v): v is string => typeof v === "string" && v !== "");
      if (notes.length > 0) out[key] = notes.join(" ");
    }
  }
  return out as CostNote;
};
