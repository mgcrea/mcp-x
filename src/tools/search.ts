import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { isRecord } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import {
  assertWithinBudget,
  compact,
  finishPostPage,
  maxResultsArg,
  paginationTokenArg,
  POST_QUERY,
  stripAt,
  wrap,
} from "#/tools/util";

/**
 * X caps a query at 512 characters on the Basic and Pro tiers and 1024 on
 * Enterprise. The builder validates against the lower bound, because a query
 * called valid here and refused by X is the worse of the two mistakes.
 */
export const MAX_QUERY_LENGTH = 512;
const MAX_QUERY_LENGTH_ENTERPRISE = 1024;

const queryArg = z
  .string()
  .min(1)
  .max(MAX_QUERY_LENGTH_ENTERPRISE)
  .describe(
    'An X search query, e.g. "rust -is:retweet lang:en". Build one with x_build_search_query if ' +
      `you are unsure of the operators. At most ${MAX_QUERY_LENGTH} characters on Basic and Pro.`,
  );

const timeArgs = {
  startTime: z
    .string()
    .optional()
    .describe('Only posts at or after this ISO-8601 UTC time, e.g. "2026-07-01T00:00:00Z".'),
  endTime: z.string().optional().describe("Only posts before this ISO-8601 UTC time."),
};

/** The filters recent and full-archive search share, described once. */
const searchFilterArgs = {
  sortOrder: z
    .enum(["recency", "relevancy"])
    .optional()
    .describe("`recency` (newest first, the default) or `relevancy`."),
  ...timeArgs,
  sinceId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe('Only posts newer than this post id, e.g. "1799000000000000001".'),
  untilId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe('Only posts older than this post id, e.g. "1799000000000000001".'),
};

/**
 * Full-archive search is capped at one request per second on top of its 15-minute
 * window. Enforced with a real gate rather than hoped for: a paginated call
 * issues several requests back to back and would trip the limit on its own.
 */
const createRateGate = (minIntervalMs: number) => {
  let last = 0;
  return async (): Promise<void> => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
  };
};

/**
 * Registered separately from the rest of search because it runs entirely
 * locally — no API call, no credentials, no cost. It stays available on an
 * unconfigured server, where getting a query right for free is the most useful
 * thing left to do.
 */
export const registerQueryBuilderTool = (server: McpServer): void => {
  server.registerTool(
    "x_build_search_query",
    {
      title: "X: Build Search Query",
      description:
        "Build an X search query from structured parts and explain each operator it used. Runs " +
        "entirely locally: no API call, no cost, no credentials. Use this to get the query right " +
        "for free, then pass the result to x_count_recent and only then to x_search_recent.",
      inputSchema: z.object({
        allWords: z.string().optional().describe('Words that must all appear, e.g. "rust async".'),
        exactPhrase: z.string().optional().describe("A phrase that must appear verbatim."),
        anyWords: z.array(z.string()).optional().describe("At least one of these must appear."),
        noneWords: z.array(z.string()).optional().describe("None of these may appear."),
        hashtags: z.array(z.string()).optional().describe('Hashtags, with or without "#".'),
        from: z.array(usernameLike()).optional().describe("Only posts by these handles."),
        to: z.array(usernameLike()).optional().describe("Only replies to these handles."),
        mentioning: z.array(usernameLike()).optional().describe("Only posts mentioning these."),
        lang: z.string().optional().describe('BCP-47 language code, e.g. "en", "fr", "ja".'),
        hasMedia: z.boolean().optional().describe("Only posts with a photo or video."),
        hasLinks: z.boolean().optional().describe("Only posts containing a link."),
        isReply: z.boolean().optional().describe("true to require replies, false to exclude them."),
        isRetweet: z
          .boolean()
          .optional()
          .describe("true to require reposts, false to exclude them. False is the usual choice."),
        isQuote: z.boolean().optional().describe("true to require quote posts, false to exclude."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => wrap(async () => buildSearchQuery(args)),
  );
};

export const registerSearchTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  const runSearch = async (
    path: string,
    args: {
      query: string;
      maxResults: number;
      sortOrder?: string | undefined;
      startTime?: string | undefined;
      endTime?: string | undefined;
      sinceId?: string | undefined;
      untilId?: string | undefined;
      paginationToken?: string | undefined;
    },
    label: string,
    gate?: () => Promise<void>,
  ) => {
    // Estimated by count, not by id: a search cannot know what it will return
    // until it returns it, so the guard uses the worst case it asked for.
    assertWithinBudget(ctx, label, ctx.ledger.estimateCount("post", args.maxResults));
    if (gate) await gate();

    const res = await client.paginate(
      path,
      compact({
        query: args.query,
        // X requires max_results between 10 and 100 on search, so a request for
        // 3 becomes a request for 10. X bills all 10, so all 10 are returned and
        // billed here — trimming to 3 would waste seven paid posts and make the
        // next_token skip them.
        max_results: Math.min(Math.max(args.maxResults, 10), 100),
        sort_order: args.sortOrder,
        start_time: args.startTime,
        end_time: args.endTime,
        since_id: args.sinceId,
        until_id: args.untilId,
        pagination_token: args.paginationToken,
        ...POST_QUERY,
      }),
      { maxItems: args.maxResults, maxPages: 5 },
    );

    return { query: args.query, ...finishPostPage(ctx, "post", res) };
  };

  server.registerTool(
    "x_search_recent",
    {
      title: "X: Search Recent",
      description:
        "Search posts from the last 7 days. Supports X's full query syntax: `from:handle`, " +
        '`to:handle`, `#tag`, `"exact phrase"`, `lang:en`, `has:media`, `has:links`, ' +
        "`url:example.com`, `conversation_id:`, and negation with `-is:retweet` or `-is:reply`. " +
        "Run x_count_recent first to see how big a query is before paying to read it.",
      inputSchema: z.object({
        query: queryArg,
        maxResults: maxResultsArg(ctx.defaultMaxResults),
        ...searchFilterArgs,
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => wrap(() => runSearch("/2/tweets/search/recent", args, "x_search_recent")),
  );

  server.registerTool(
    "x_count_recent",
    {
      title: "X: Count Recent",
      description:
        "Count how many posts match a query over the last 7 days WITHOUT reading any of them. " +
        "This endpoint returns only totals, so it costs nothing per post — always run it before " +
        "a broad x_search_recent to find out whether you are about to read 10 posts or 10,000.",
      inputSchema: z.object({
        query: queryArg,
        granularity: z
          .enum(["minute", "hour", "day"])
          .default("day")
          .describe(
            "Bucket size for the time series. Defaults to day. Note that `minute` over the " +
              "full 7-day window is about 10,000 buckets, so pair it with a time window.",
          ),
        ...timeArgs,
        maxBuckets: z
          .number()
          .int()
          .min(1)
          .max(10_080)
          .default(200)
          .describe(
            "How many time buckets to return, newest first. The total is always complete; " +
              "this only bounds the series. Defaults to 200.",
          ),
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, granularity, startTime, endTime, maxBuckets, paginationToken }) =>
      wrap(async () => {
        const raw = await client.get(
          "/2/tweets/counts/recent",
          compact({
            query,
            granularity,
            start_time: startTime,
            end_time: endTime,
            next_token: paginationToken,
          }),
        );
        const meta = isRecord(raw) && isRecord(raw.meta) ? raw.meta : {};
        const total = typeof meta.total_tweet_count === "number" ? meta.total_tweet_count : 0;
        const estimated = ctx.ledger.estimateCount("post", total);
        const buckets = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
        return {
          query,
          total_posts: total,
          buckets: buckets.slice(0, maxBuckets),
          bucket_count: buckets.length,
          ...(buckets.length > maxBuckets ? { buckets_truncated: true } : {}),
          ...(typeof meta.next_token === "string" && meta.next_token
            ? { next_token: meta.next_token }
            : {}),
          cost: { estimated_usd: 0, note: "Counts are not billed per post." },
          reading_all_would_cost_usd: Math.round(estimated * 100) / 100,
          ...(total > 100
            ? {
                advice:
                  `Reading all ${total} matches would cost about ` +
                  `$${(Math.round(estimated * 100) / 100).toFixed(2)}. Narrow the query with ` +
                  `-is:retweet, lang:, or a tighter time window before searching.`,
              }
            : {}),
        };
      }),
  );

  // Full-archive search is a paid-tier endpoint; registering it when it cannot
  // work would just hand the model a tool that always 403s.
  if (!ctx.enableFullArchive) return;

  const archiveGate = createRateGate(1000);

  server.registerTool(
    "x_search_all",
    {
      title: "X: Search All",
      description:
        "Search the FULL archive, back to X's first post in March 2006 — not just the last 7 " +
        "days. Requires a paid access tier and is limited to one request per second, so it is " +
        "slower than x_search_recent. Same query syntax. Costs the same per post read.",
      inputSchema: z.object({
        query: queryArg,
        maxResults: maxResultsArg(ctx.defaultMaxResults),
        ...searchFilterArgs,
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() => runSearch("/2/tweets/search/all", args, "x_search_all", archiveGate)),
  );
};

function usernameLike() {
  return z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/);
}

type QueryParts = {
  allWords?: string | undefined;
  exactPhrase?: string | undefined;
  anyWords?: string[] | undefined;
  noneWords?: string[] | undefined;
  hashtags?: string[] | undefined;
  from?: string[] | undefined;
  to?: string[] | undefined;
  mentioning?: string[] | undefined;
  lang?: string | undefined;
  hasMedia?: boolean | undefined;
  hasLinks?: boolean | undefined;
  isReply?: boolean | undefined;
  isRetweet?: boolean | undefined;
  isQuote?: boolean | undefined;
};

/** Grouped with OR and parenthesised, which is what X's `from:a OR from:b` needs. */
const orGroup = (operator: string, values: string[]): string =>
  values.length === 1
    ? `${operator}:${values[0]}`
    : `(${values.map((v) => `${operator}:${v}`).join(" OR ")})`;

/**
 * X's query language has no escape for a literal double quote, so one inside a
 * term is dropped rather than passed through to break the whole query.
 */
const unquoted = (value: string): string => value.trim().replace(/"/g, "");

/** A term X would otherwise split on whitespace is quoted so it stays one term. */
const term = (value: string): string => {
  const clean = unquoted(value);
  return /\s/.test(clean) ? `"${clean}"` : clean;
};

export const buildSearchQuery = (
  parts: QueryParts,
): { query: string; explanation: string[]; length: number; valid: boolean; warning?: string } => {
  const clauses: string[] = [];
  const explanation: string[] = [];

  if (parts.allWords?.trim()) {
    clauses.push(parts.allWords.trim());
    explanation.push(`\`${parts.allWords.trim()}\` — all of these words must appear.`);
  }
  if (unquoted(parts.exactPhrase ?? "")) {
    const phrase = `"${unquoted(parts.exactPhrase ?? "")}"`;
    clauses.push(phrase);
    explanation.push(`\`${phrase}\` — this exact phrase must appear.`);
  }
  const anyWords = (parts.anyWords ?? []).map(term).filter(Boolean);
  if (anyWords.length > 0) {
    const group = anyWords.length === 1 ? anyWords[0] : `(${anyWords.join(" OR ")})`;
    clauses.push(group as string);
    explanation.push(`\`${group}\` — at least one of these must appear.`);
  }
  for (const word of (parts.noneWords ?? []).map(term).filter(Boolean)) {
    // Quoted when multi-word: `-machine learning` excludes "machine" and then
    // *requires* "learning", which is the opposite of what was asked.
    clauses.push(`-${word}`);
    explanation.push(`\`-${word}\` — excludes posts containing ${word}.`);
  }
  for (const tag of parts.hashtags ?? []) {
    const clean = tag.startsWith("#") ? tag : `#${tag}`;
    clauses.push(clean);
    explanation.push(`\`${clean}\` — must carry this hashtag.`);
  }
  if (parts.from?.length) {
    const handles = parts.from.map(stripAt);
    clauses.push(orGroup("from", handles));
    explanation.push(
      `\`from:\` — only posts authored by ${handles.map((h) => `@${h}`).join(" or ")}.`,
    );
  }
  if (parts.to?.length) {
    const handles = parts.to.map(stripAt);
    clauses.push(orGroup("to", handles));
    explanation.push(
      `\`to:\` — only replies addressed to ${handles.map((h) => `@${h}`).join(" or ")}.`,
    );
  }
  for (const handle of (parts.mentioning ?? []).map(stripAt)) {
    clauses.push(`@${handle}`);
    explanation.push(`\`@${handle}\` — must mention this account.`);
  }
  if (parts.lang) {
    clauses.push(`lang:${parts.lang}`);
    explanation.push(`\`lang:${parts.lang}\` — only posts X detected as this language.`);
  }
  if (parts.hasMedia !== undefined) {
    clauses.push(`${parts.hasMedia ? "" : "-"}has:media`);
    explanation.push(
      `\`${parts.hasMedia ? "" : "-"}has:media\` — ${parts.hasMedia ? "requires" : "excludes"} posts with a photo or video.`,
    );
  }
  if (parts.hasLinks !== undefined) {
    clauses.push(`${parts.hasLinks ? "" : "-"}has:links`);
    explanation.push(
      `\`${parts.hasLinks ? "" : "-"}has:links\` — ${parts.hasLinks ? "requires" : "excludes"} posts containing a link.`,
    );
  }
  for (const [flag, name] of [
    [parts.isReply, "reply"],
    [parts.isRetweet, "retweet"],
    [parts.isQuote, "quote"],
  ] as const) {
    if (flag === undefined) continue;
    clauses.push(`${flag ? "" : "-"}is:${name}`);
    explanation.push(
      `\`${flag ? "" : "-"}is:${name}\` — ${flag ? "only" : "never"} ${name} posts.` +
        (name === "retweet" && !flag
          ? " This is the single most useful filter: it removes the duplicate noise of reposts."
          : ""),
    );
  }

  const query = clauses.join(" ");
  return {
    query,
    explanation,
    length: query.length,
    valid: query.length > 0 && query.length <= MAX_QUERY_LENGTH,
    ...(query.length === 0 ? { warning: "No criteria given — the query is empty." } : {}),
    ...(query.length > MAX_QUERY_LENGTH
      ? {
          warning:
            `Query is ${query.length} characters; X's limit is ${MAX_QUERY_LENGTH} on Basic and ` +
            `Pro (${MAX_QUERY_LENGTH_ENTERPRISE} on Enterprise).`,
        }
      : {}),
  };
};
