import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { isRecord } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import { validateIntent } from "#/compose/intent";
import { openInBrowser } from "#/compose/open";
import type { ToolContext } from "#/tools/index";
import { compact, confirmArg, postIdArg, wrap } from "#/tools/util";

const textArg = z
  .string()
  .min(1)
  .describe("The body of the post. Counted against X's 280 weighted-character limit.");

const urlArg = z
  .string()
  .url()
  .optional()
  .describe(
    "A link to append. X shortens every link to a fixed 23 characters, so its real length does " +
      "not matter — but those 23 do count.",
  );

const hashtagsArg = z
  .array(z.string())
  .optional()
  .describe('Hashtags, with or without "#". More than four tends to suppress reach.');

const viaArg = z.string().optional().describe('An attribution handle, appended as "via @handle".');

export const registerComposeTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "x_validate_post",
    {
      title: "X: Validate Post",
      description:
        "Check a draft against X's 280-character limit before doing anything with it. X counts " +
        "weighted characters, not plain ones: every URL costs 23 whatever its length, and CJK " +
        "characters and emoji cost 2 each — so 140 Japanese characters is already a full post. " +
        "Runs locally; no API call, no cost.",
      inputSchema: z.object({
        text: textArg,
        url: urlArg,
        hashtags: hashtagsArg,
        via: viaArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ text, url, hashtags, via }) =>
      wrap(async () => {
        const {
          intent_url: _intentUrl,
          urls: _urls,
          ...validation
        } = validateIntent({
          text,
          url,
          hashtags,
          via,
        });
        return validation;
      }),
  );

  server.registerTool(
    "x_compose_post",
    {
      title: "X: Compose Post",
      description:
        "The default way to post. Validates the draft and returns an x.com/intent/tweet URL " +
        "that opens X's composer pre-filled — you click Post yourself. This is FREE: no API " +
        "quota, no write scope, no credentials, and nothing is published without a human click. " +
        "Prefer it over x_create_post, which costs $0.015 per post ($0.200 with a URL). " +
        "Web intents cannot attach media, create polls, make native quote posts, or build " +
        "threads — those need the paid API. Replying to a post does work.",
      inputSchema: z.object({
        text: textArg,
        url: urlArg,
        hashtags: hashtagsArg,
        via: viaArg,
        inReplyTo: postIdArg
          .optional()
          .describe("Post id to reply to. The composer opens in reply context."),
        open: z
          .boolean()
          .optional()
          .describe(
            "Open the URL in your browser. Defaults to the server's X_AUTO_OPEN_BROWSER " +
              "setting. The URL is returned either way.",
          ),
      }),
      // Not readOnly (it may open a browser), but deliberately NOT gated behind
      // allowWrites: it changes nothing without a human click, and gating the
      // free path would push people toward the paid one.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ text, url, hashtags, via, inReplyTo, open }) =>
      wrap(async () => {
        const validation = validateIntent({ text, url, hashtags, via, inReplyTo });
        if (!validation.valid) {
          return {
            ...validation,
            cost: { estimated_usd: 0, note: "Nothing was sent — the draft is not postable." },
          };
        }

        const shouldOpen = open ?? ctx.autoOpenBrowser;
        const result = shouldOpen
          ? await openInBrowser(validation.intent_url)
          : { opened: false, reason: "not requested" };

        return {
          intent_url: validation.intent_url,
          opened: result.opened,
          ...(result.reason ? { open_note: result.reason } : {}),
          composed: validation.composed,
          weighted_length: validation.weighted,
          remaining: validation.remaining,
          valid: true,
          warnings: validation.warnings,
          next_step: result.opened
            ? "X's composer is open in your browser — review it and click Post."
            : "Open the intent_url above to review and post it.",
          cost: {
            estimated_usd: 0,
            note: "Web intent — no API call, no quota consumed, no credentials used.",
          },
        };
      }),
  );

  // Everything below publishes through the paid API. Registered only when both
  // flags are on, so with the defaults these tools do not exist at all.
  if (!ctx.allowWrites || ctx.writeBackend !== "api") return;

  server.registerTool(
    "x_create_post",
    {
      title: "X: Create Post",
      description:
        "Publish a post directly through the API. COSTS MONEY: about $0.015 per post, or $0.200 " +
        "if it contains a URL — forty times a post read. x_compose_post does the same thing for " +
        "free via a browser click; use this only when you specifically need unattended posting, " +
        "a thread, or a native quote post.",
      inputSchema: z.object({
        text: textArg,
        replyToPostId: postIdArg.optional().describe("Post id to reply to."),
        quotePostId: postIdArg.optional().describe("Post id to quote."),
        replySettings: z
          .enum(["everyone", "mentionedUsers", "following"])
          .optional()
          .describe("Who may reply. Defaults to everyone."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ text, replyToPostId, quotePostId, replySettings }) =>
      wrap(async () => {
        const validation = validateIntent({ text });
        if (!validation.valid) {
          return { error: validation.error, weighted_length: validation.weighted };
        }

        const res = await client.post(
          "/2/tweets",
          compact({
            text,
            ...(replyToPostId ? { reply: { in_reply_to_tweet_id: replyToPostId } } : {}),
            ...(quotePostId ? { quote_tweet_id: quotePostId } : {}),
            ...(replySettings ? { reply_settings: replySettings } : {}),
          }),
        );

        // Same detector the character count uses, so the cost note and the
        // 280 check agree on what a link is. A looser regex here once billed
        // "shipped v1.20" at the with-URL rate — thirteen times the real price.
        const hasUrl = validation.urls.length > 0;
        ctx.ledger.recordCreate(hasUrl);

        const data = isRecord(res) && isRecord(res.data) ? res.data : {};
        const id = typeof data.id === "string" ? data.id : undefined;
        return {
          posted: true,
          id,
          ...(id ? { url: `https://x.com/i/web/status/${id}` } : {}),
          cost: {
            estimated_usd: hasUrl ? ctx.pricing.postCreateWithUrl : ctx.pricing.postCreate,
            note: hasUrl
              ? "Billed at the with-URL rate. x_compose_post would have cost nothing."
              : "x_compose_post would have cost nothing.",
          },
        };
      }),
  );

  server.registerTool(
    "x_delete_post",
    {
      title: "X: Delete Post",
      description:
        "Delete one of your own posts. Irreversible — X keeps no undo, and the id cannot be " +
        "reused.",
      inputSchema: z.object({ postId: postIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ postId }) =>
      wrap(async () => {
        await client.del(`/2/tweets/${postId}`);
        return { deleted: postId };
      }),
  );
};
