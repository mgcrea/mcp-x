import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { shapePostsResponse, type ShapedPost } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import {
  assertWithinBudget,
  cachedByIds,
  compact,
  finishPostPage,
  maxResultsArg,
  mergeCostNotes,
  paginationTokenArg,
  POST_QUERY,
  postIdArg,
  wrap,
} from "#/tools/util";

export const registerPostTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  /** One batched lookup, shared by the single- and multi-id tools. */
  const fetchPosts = async (ids: string[]): Promise<Map<string, ShapedPost>> => {
    const raw = await client.get("/2/tweets", compact({ ids, ...POST_QUERY }));
    const shaped = shapePostsResponse(raw);
    return new Map(shaped.posts.map((post) => [post.id, post]));
  };

  server.registerTool(
    "x_get_post",
    {
      title: "X: Get Post",
      description:
        "Get one post by id, with its author, metrics, media and any quoted or replied-to post " +
        "already inlined. Reading the same post twice in one UTC day is free — X does not bill " +
        "a repeat read.",
      inputSchema: z.object({ postId: postIdArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId }) =>
      wrap(async () => {
        const { items, cost, notFound } = await cachedByIds(
          ctx,
          "post",
          [postId],
          fetchPosts,
          "x_get_post",
        );
        if (items.length === 0) {
          return {
            error:
              `X returned no post for id ${notFound[0]}. It is deleted, protected, or from a ` +
              `suspended account.`,
            cost,
          };
        }
        return { post: items[0], cost };
      }),
  );

  server.registerTool(
    "x_get_posts",
    {
      title: "X: Get Posts",
      description:
        "Get up to 100 posts by id in a single request. Always prefer this over calling " +
        "x_get_post repeatedly — X bills per post either way, but one request is far faster and " +
        "spends only one unit of rate limit. Ids that cannot be served come back under " +
        "`not_found` rather than failing the call.",
      inputSchema: z.object({
        postIds: z
          .array(postIdArg)
          .min(1)
          .max(100)
          .describe("Post ids to look up, up to 100 in one call."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postIds }) =>
      wrap(async () => {
        // De-duplicate up front: asking for the same id twice in one call would
        // otherwise look like two reads to the caller reading the cost note.
        const unique = [...new Set(postIds)];
        const { items, cost, notFound } = await cachedByIds(
          ctx,
          "post",
          unique,
          fetchPosts,
          "x_get_posts",
        );
        return {
          posts: items,
          ...(notFound.length > 0 ? { not_found: notFound } : {}),
          cost,
        };
      }),
  );

  server.registerTool(
    "x_get_thread",
    {
      title: "X: Get Thread",
      description:
        "Reconstruct a conversation: every reply sharing the post's conversation_id, oldest " +
        "first. Note that this searches the last 7 days only, so an older thread returns just " +
        "the root post. Costs one post read for the root plus one per reply returned; a root " +
        "already read today is free.",
      inputSchema: z.object({
        postId: postIdArg,
        maxResults: maxResultsArg(ctx.defaultMaxResults),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId, maxResults }) =>
      wrap(async () => {
        // The root post carries the conversation_id, which may differ from its
        // own id when the post is itself a reply. Read through the cache so a
        // root fetched by x_get_post moments ago is neither re-requested nor
        // re-billed, and so the budget guard sees it.
        const root = await cachedByIds(ctx, "post", [postId], fetchPosts, "x_get_thread");
        const rootPost = root.items[0];
        if (!rootPost) {
          return { error: `X returned no post for id ${postId}.`, cost: root.cost };
        }

        assertWithinBudget(ctx, "x_get_thread", ctx.ledger.estimateCount("post", maxResults));
        const conversationId = rootPost.conversation_id ?? rootPost.id;
        const replies = await client.paginate(
          "/2/tweets/search/recent",
          compact({
            query: `conversation_id:${conversationId}`,
            max_results: Math.min(Math.max(maxResults, 10), 100),
            sort_order: "recency",
            ...POST_QUERY,
          }),
          { maxItems: maxResults },
        );
        const page = finishPostPage(ctx, "post", replies);
        // Oldest first: a thread reads top-down, but search returns newest first.
        const ordered = page.posts.toReversed().filter((p) => p.id !== rootPost.id);

        return {
          conversation_id: conversationId,
          posts: [rootPost, ...ordered],
          ...(page.next_token ? { next_token: page.next_token } : {}),
          note:
            "Recent search reaches back 7 days. Replies older than that are not returned even " +
            "if the thread has more.",
          cost: mergeCostNotes(root.cost, page.cost),
        };
      }),
  );

  server.registerTool(
    "x_get_quotes",
    {
      title: "X: Get Quotes",
      description:
        "List posts quoting a given post, newest first — who is amplifying or arguing with it. " +
        "Works with the app-only Bearer token. Costs one post read per quote returned (about " +
        "$0.005 each, and X serves at least 10 per page), so keep maxResults low on a viral post.",
      inputSchema: z.object({
        postId: postIdArg,
        maxResults: maxResultsArg(ctx.defaultMaxResults),
        paginationToken: paginationTokenArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId, maxResults, paginationToken }) =>
      wrap(async () => {
        assertWithinBudget(ctx, "x_get_quotes", ctx.ledger.estimateCount("post", maxResults));
        const res = await client.paginate(
          `/2/tweets/${postId}/quote_tweets`,
          compact({
            max_results: Math.min(Math.max(maxResults, 10), 100),
            pagination_token: paginationToken,
            ...POST_QUERY,
          }),
          { maxItems: maxResults },
        );
        return finishPostPage(ctx, "post", res);
      }),
  );
};
