import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "#/client/errors";
import { shapeUsersResponse, type ShapedUser } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import {
  assertWithinBudget,
  cachedByIds,
  compact,
  finishPostPage,
  maxResultsArg,
  paginationTokenArg,
  POST_QUERY,
  recordResultCost,
  stripAt,
  USER_QUERY,
  userIdArg,
  usernameArg,
  wrap,
} from "#/tools/util";

/**
 * Resolve a handle to the numeric id X's timeline endpoints require. Cached and
 * billed as a user read, because that is exactly what it is.
 */
const resolveUserId = async (
  client: XApiClient,
  ctx: ToolContext,
  opts: { username?: string | undefined; userId?: string | undefined },
): Promise<{ id: string; user?: ShapedUser }> => {
  if (opts.userId) return { id: opts.userId };
  if (!opts.username) {
    throw new PreconditionError("Provide either `username` or `userId`.", { got: opts });
  }
  const handle = stripAt(opts.username);
  // A handle lookup is a user read with an id nobody knows yet, so the guard
  // sees it as one worst-case read rather than not at all.
  assertWithinBudget(ctx, `lookup @${handle}`, ctx.ledger.estimateCount("user", 1));
  const raw = await client.get(`/2/users/by/username/${handle}`, compact({ ...USER_QUERY }));
  const shaped = shapeUsersResponse(raw);
  const user = shaped.users[0];
  if (!user?.id) {
    throw new PreconditionError(`No X account found for @${handle}.`, { username: handle });
  }
  ctx.cache.set("user", user.id, user);
  ctx.ledger.record("user", [user.id]);
  return { id: user.id, user };
};

export const registerUserTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  const fetchUsersByIds = async (ids: string[]): Promise<Map<string, ShapedUser>> => {
    const raw = await client.get("/2/users", compact({ ids, ...USER_QUERY }));
    return new Map(shapeUsersResponse(raw).users.map((u) => [u.id, u]));
  };

  server.registerTool(
    "x_get_user",
    {
      title: "X: Get User",
      description:
        "Look up one profile by handle or numeric id: bio, follower and post counts, join date. " +
        "A user read costs about $0.010, twice a post read.",
      inputSchema: z.object({
        username: usernameArg.optional(),
        userId: userIdArg.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, userId }) =>
      wrap(async () => {
        if (!username && !userId) {
          throw new PreconditionError(
            'Provide either `username` (a handle like "mgcrea") or `userId` (digits).',
          );
        }
        if (username && userId) {
          throw new PreconditionError(
            "Provide only one of `username` or `userId` — they may disagree.",
            { username, userId },
          );
        }

        if (userId) {
          const { items, cost, notFound } = await cachedByIds(
            ctx,
            "user",
            [userId],
            fetchUsersByIds,
            "x_get_user",
          );
          return items[0]
            ? { user: items[0], cost }
            : { error: `No X account found for id ${notFound[0]}.`, cost };
        }

        const handle = stripAt(username as string);
        assertWithinBudget(ctx, "x_get_user", ctx.ledger.estimateCount("user", 1));
        const raw = await client.get(`/2/users/by/username/${handle}`, compact({ ...USER_QUERY }));
        const shaped = shapeUsersResponse(raw);
        const user = shaped.users[0];
        if (!user) return { error: `No X account found for @${handle}.` };
        ctx.cache.set("user", user.id, user);
        return { user, cost: recordResultCost(ctx, "user", [user.id]) };
      }),
  );

  server.registerTool(
    "x_get_users",
    {
      title: "X: Get Users",
      description:
        "Look up up to 100 profiles at once, by handle or by id. One request instead of many, " +
        "billed per profile returned.",
      inputSchema: z.object({
        usernames: z
          .array(usernameArg)
          .min(1)
          .max(100)
          .optional()
          .describe('Handles to look up, e.g. ["mgcrea", "acme"].'),
        userIds: z
          .array(userIdArg)
          .min(1)
          .max(100)
          .optional()
          .describe('Numeric ids to look up, e.g. ["44196397"]. Use one of usernames or userIds.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ usernames, userIds }) =>
      wrap(async () => {
        if (!usernames && !userIds) {
          throw new PreconditionError("Provide either `usernames` or `userIds`.");
        }
        if (usernames && userIds) {
          throw new PreconditionError("Provide only one of `usernames` or `userIds`.");
        }

        if (userIds) {
          const unique = [...new Set(userIds)];
          const { items, cost, notFound } = await cachedByIds(
            ctx,
            "user",
            unique,
            fetchUsersByIds,
            "x_get_users",
          );
          return {
            users: items,
            ...(notFound.length > 0 ? { not_found: notFound } : {}),
            cost,
          };
        }

        const handles = [...new Set((usernames as string[]).map(stripAt))];
        assertWithinBudget(ctx, "x_get_users", ctx.ledger.estimateCount("user", handles.length));
        const raw = await client.get("/2/users/by", compact({ usernames: handles, ...USER_QUERY }));
        const shaped = shapeUsersResponse(raw);
        for (const user of shaped.users) ctx.cache.set("user", user.id, user);
        return {
          users: shaped.users,
          ...(shaped.not_found ? { not_found: shaped.not_found } : {}),
          cost: recordResultCost(
            ctx,
            "user",
            shaped.users.map((u) => u.id),
          ),
        };
      }),
  );

  server.registerTool(
    "x_get_user_posts",
    {
      title: "X: Get User Posts",
      description:
        "A user's own recent posts, newest first. Replies and reposts are excluded by default " +
        "so you get their original writing; set the flags to include them. Reaches back roughly " +
        "3200 posts, X's timeline limit.",
      inputSchema: z.object({
        username: usernameArg.optional(),
        userId: userIdArg.optional(),
        maxResults: maxResultsArg(ctx.defaultMaxResults),
        excludeReplies: z
          .boolean()
          .default(true)
          .describe("Leave out replies to other people. Defaults to true."),
        excludeReposts: z
          .boolean()
          .default(true)
          .describe("Leave out reposts (retweets). Defaults to true."),
        startTime: z
          .string()
          .optional()
          .describe('Only posts at or after this ISO-8601 UTC time, e.g. "2026-07-01T00:00:00Z".'),
        endTime: z.string().optional().describe("Only posts before this ISO-8601 UTC time."),
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({
      username,
      userId,
      maxResults,
      excludeReplies,
      excludeReposts,
      startTime,
      endTime,
      paginationToken,
    }) =>
      wrap(async () => {
        const { id } = await resolveUserId(client, ctx, { username, userId });
        assertWithinBudget(ctx, "x_get_user_posts", ctx.ledger.estimateCount("post", maxResults));
        const exclude = [
          ...(excludeReplies ? ["replies"] : []),
          ...(excludeReposts ? ["retweets"] : []),
        ];
        const res = await client.paginate(
          `/2/users/${id}/tweets`,
          compact({
            max_results: Math.min(Math.max(maxResults, 5), 100),
            exclude: exclude.length > 0 ? exclude : undefined,
            start_time: startTime,
            end_time: endTime,
            pagination_token: paginationToken,
            ...POST_QUERY,
          }),
          { maxItems: maxResults },
        );
        return { user_id: id, ...finishPostPage(ctx, "post", res) };
      }),
  );

  server.registerTool(
    "x_get_user_mentions",
    {
      title: "X: Get User Mentions",
      description:
        "Posts mentioning a user, newest first — who is talking about them, and what. Works " +
        "with the app-only Bearer token for any public account. Costs one post read per " +
        "mention returned (about $0.005 each, at least 5 per page); the handle lookup, when " +
        "`username` is given instead of `userId`, is one user read on top.",
      inputSchema: z.object({
        username: usernameArg.optional(),
        userId: userIdArg.optional(),
        maxResults: maxResultsArg(ctx.defaultMaxResults),
        startTime: z.string().optional().describe("Only posts at or after this ISO-8601 UTC time."),
        endTime: z.string().optional().describe("Only posts before this ISO-8601 UTC time."),
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, userId, maxResults, startTime, endTime, paginationToken }) =>
      wrap(async () => {
        const { id } = await resolveUserId(client, ctx, { username, userId });
        assertWithinBudget(
          ctx,
          "x_get_user_mentions",
          ctx.ledger.estimateCount("post", maxResults),
        );
        const res = await client.paginate(
          `/2/users/${id}/mentions`,
          compact({
            max_results: Math.min(Math.max(maxResults, 5), 100),
            start_time: startTime,
            end_time: endTime,
            pagination_token: paginationToken,
            ...POST_QUERY,
          }),
          { maxItems: maxResults },
        );
        return { user_id: id, ...finishPostPage(ctx, "post", res) };
      }),
  );
};

export { resolveUserId };
