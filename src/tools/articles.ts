import { dirname } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError, XApiRequestError } from "#/client/errors";
import { isRecord, shapeArticlesResponse, type ArticleRead } from "#/client/shape";
import type { XApiClient } from "#/client/x";
import {
  ARTICLE_IMAGE_CATEGORY,
  ARTICLE_MARKDOWN_LIMIT,
  articleParagraphs,
  attachImages,
  markdownToArticle,
  type ArticleConversion,
} from "#/compose/article";
import { diffParagraphs, normalizeParagraph } from "#/compose/diff";
import {
  readLocalImage,
  readMarkdownFile,
  resolveLocalPath,
  type LocalImage,
} from "#/compose/image";
import type { ToolContext } from "#/tools/index";
import { cachedByIds, compact, confirmArg, postIdArg, wrap } from "#/tools/util";

// X Articles: the long-form posts with a title, headings and images.
//
// The API is small and lopsided, and the tool descriptions have to say so,
// because the obvious plan fails against it. Reading is an ordinary post lookup
// with `tweet.fields=article`. Writing is exactly two endpoints — create a
// draft, publish a draft — and nothing else: no update, no delete, no listing,
// no reading a draft back. A published Article cannot be edited through the
// API at all, so "keep X in sync with the blog" is x_compare_article telling
// you what drifted, not a tool that pushes a revision.

/**
 * Everything x_get_article needs in one read. `article` rather than the
 * `article_title` every other read asks for: it is the field that carries the
 * body, on a read that is billed the same either way.
 */
const ARTICLE_QUERY = {
  expansions: ["author_id", "article.cover_media", "article.media_entities"],
  "tweet.fields": ["article", "created_at", "public_metrics"],
  "user.fields": ["username", "name"],
  "media.fields": ["type", "url", "preview_image_url", "alt_text"],
};

const UNPRICED =
  "X publishes no price for the Articles or media upload endpoints (checked 2026-09-12), so " +
  "this is not estimated and not counted by x_get_usage_report. The developer console has the " +
  "real figure.";

const ARTICLE_HINT =
  "Articles need X Premium on the posting account, and a login that granted tweet.write.";

const MEDIA_HINT =
  "Uploading needs the media.write scope, which logins made before Article support did not " +
  "request: call x_login again, then retry.";

/** Name the likely cause on the two statuses whose generic message points somewhere else. */
const explain =
  (hint: string) =>
  (err: unknown): never => {
    if (err instanceof XApiRequestError && (err.status === 401 || err.status === 403)) {
      throw new XApiRequestError(`${err.message} ${hint}`, {
        status: err.status,
        errors: err.errors,
      });
    }
    throw err;
  };

const markdownArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The body as Markdown. Pass this or markdownPath, not both. Relative image paths only " +
      "resolve with markdownPath.",
  );

const markdownPathArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Absolute path to a .md, .markdown or .mdx file, e.g. "/Users/me/site/src/content/blog/post.md". ' +
      "Its front matter supplies `title` and `cover`, and relative image paths resolve against " +
      "its directory, as a site generator reads them.",
  );

const titleArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The Article title. Defaults to the front matter's `title`, then to a leading `# Heading`, " +
      "which is then removed from the body.",
  );

const linkBaseUrlArg = z
  .string()
  .url()
  .optional()
  .describe(
    'The site the Markdown was written for, e.g. "https://mg-crea.com". Relative links such as ' +
      "/blog/next-post resolve against it; without it they keep their text and lose the link, " +
      "because on X they would point nowhere.",
  );

const articlePostIdArg = postIdArg.describe(
  "The id of the post that carries the Article: the digits ending x.com/<handle>/status/<id>. " +
    "An x.com/i/article/<id> link holds either that id or the Article's own, which the API " +
    "cannot look up — try it, and not-found means the latter.",
);

type MarkdownSource = { text: string; baseDir?: string };

const loadMarkdown = (args: {
  markdown?: string | undefined;
  markdownPath?: string | undefined;
}): MarkdownSource => {
  if (args.markdown !== undefined && args.markdownPath !== undefined) {
    throw new PreconditionError("Pass markdown or markdownPath, not both.");
  }
  if (args.markdownPath !== undefined) {
    const file = readMarkdownFile(args.markdownPath);
    return { text: file.text, baseDir: dirname(file.path) };
  }
  if (args.markdown !== undefined) return { text: args.markdown };
  throw new PreconditionError("Pass the body as markdown, or a Markdown file as markdownPath.");
};

type ImageCheck = { src: string; path?: string; format?: string; bytes?: number; error?: string };

const checkImage = (src: string, baseDir: string | undefined): ImageCheck => {
  try {
    const file = readLocalImage(resolveLocalPath(src, baseDir));
    return { src, path: file.path, format: file.format, bytes: file.bytes.length };
  } catch (err) {
    return { src, error: err instanceof Error ? err.message : String(err) };
  }
};

/** What X would refuse, as opposed to what it would merely render differently (`warnings`). */
const blockingProblems = (conversion: ArticleConversion, images: ImageCheck[] = []): string[] => [
  ...(conversion.title
    ? []
    : [
        "No title: pass `title`, set one in the front matter, or start the body with a `# Heading`.",
      ]),
  ...(conversion.contentState.blocks.length === 0 ? ["The body is empty."] : []),
  ...(conversion.markdownWeightedLength > ARTICLE_MARKDOWN_LIMIT
    ? [
        `Code blocks and tables total ${conversion.markdownWeightedLength} weighted characters, ` +
          `past X's ${ARTICLE_MARKDOWN_LIMIT} per Article.`,
      ]
    : []),
  ...images.flatMap((image) => (image.error ? [image.error] : [])),
];

const countBy = (values: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
};

const notServed = (postId: string): string =>
  `X returned no post for id ${postId}. It is deleted, protected, or from a suspended account — ` +
  "or the id is an Article's own rather than the id of the post that carries it.";

const notAnArticle = (postId: string): string =>
  `Post ${postId} is not an Article. Read it with x_get_post.`;

/**
 * The free, local half: registered with no credentials at all, like
 * x_validate_post, so a draft can be checked before anything is configured.
 */
export const registerArticleComposeTools = (server: McpServer): void => {
  server.registerTool(
    "x_validate_article",
    {
      title: "X: Validate Article",
      description:
        "Preview how Markdown becomes an X Article before anything is uploaded or created: the " +
        "title it will use, the outline, each image and whether it can be uploaded, the posts " +
        "it embeds, and every construct an Article cannot express (h4-h6, nested lists, inline " +
        "code, raw HTML). Runs locally — no API call, no cost, no credentials. " +
        "x_create_article_draft runs the identical conversion, so what this reports is what X " +
        "receives.",
      inputSchema: z.object({
        markdown: markdownArg,
        markdownPath: markdownPathArg,
        title: titleArg,
        linkBaseUrl: linkBaseUrlArg,
        includeContentState: z
          .boolean()
          .default(false)
          .describe(
            "Also return the DraftJS content state X would receive. Off by default: it runs " +
              "several times the size of the Markdown.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ markdown, markdownPath, title, linkBaseUrl, includeContentState }) =>
      wrap(async () => {
        const source = loadMarkdown({ markdown, markdownPath });
        const conversion = markdownToArticle(source.text, compact({ title, linkBaseUrl }));
        const images = conversion.images.map((image) => checkImage(image.src, source.baseDir));
        const cover = conversion.frontMatter.cover
          ? checkImage(conversion.frontMatter.cover, source.baseDir)
          : undefined;
        const problems = blockingProblems(conversion, images);
        const { blocks } = conversion.contentState;

        return {
          ready: problems.length === 0,
          ...(conversion.title ? { title: conversion.title } : {}),
          blocks: blocks.length,
          block_types: countBy(blocks.map((block) => block.type)),
          outline: conversion.outline,
          ...(images.length > 0 ? { images } : {}),
          ...(conversion.embeddedPosts.length > 0
            ? { embedded_posts: conversion.embeddedPosts }
            : {}),
          ...(cover
            ? {
                front_matter_cover: {
                  ...cover,
                  note: "Not uploaded on its own — pass it as coverImagePath to use it.",
                },
              }
            : {}),
          markdown_weighted_length: conversion.markdownWeightedLength,
          ...(problems.length > 0 ? { problems } : {}),
          warnings: conversion.warnings,
          ...(includeContentState ? { content_state: conversion.contentState } : {}),
          cost: { estimated_usd: 0, note: "Converted locally — no API call." },
        };
      }),
  );
};

export const registerArticleTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  const fetchArticles = async (ids: string[]): Promise<Map<string, ArticleRead>> => {
    const raw = await client.get("/2/tweets", compact({ ids, ...ARTICLE_QUERY }));
    return new Map(shapeArticlesResponse(raw).map((read) => [read.post_id, read]));
  };

  /**
   * One post read, billed as the post it is and cached as an Article, so paging
   * through a body and comparing it afterwards re-read nothing.
   */
  const readArticle = (postId: string, label: string) =>
    cachedByIds(ctx, "post", [postId], fetchArticles, label, "article");

  server.registerTool(
    "x_get_article",
    {
      title: "X: Get Article",
      description:
        "Read an X Article — the long-form kind with a title, headings and images — in full: " +
        "title, body text, cover image, the images and posts it embeds, and the links it cites. " +
        "x_get_post shows an Article only as a link with `article.title`. Costs one post read " +
        "(~$0.005). Paging a long body with `offset` re-reads nothing: the Article is cached " +
        "for the UTC day, which X does not bill twice anyway.",
      inputSchema: z.object({
        postId: articlePostIdArg,
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Character offset into the body: the `next_offset` a previous call returned. 0 " +
              "starts at the top and also returns the title, cover and link lists.",
          ),
        maxChars: z
          .number()
          .int()
          .min(1000)
          .max(100_000)
          .default(20_000)
          .describe(
            "Body characters to return in this call (1,000-100,000). Defaults to 20,000, about " +
              "5,000 tokens; long Articles run past 50,000, and the rest is free with `offset`.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId, offset, maxChars }) =>
      wrap(async () => {
        const { items, cost } = await readArticle(postId, "x_get_article");
        const read = items[0];
        if (!read) return { error: notServed(postId), cost };
        const { article, ...post } = read;
        if (!article) return { error: notAnArticle(postId), url: post.url, cost };

        const { body, title, ...details } = article;
        if (offset > body.length) {
          throw new PreconditionError(
            `offset ${offset} is past the end of the body, which is ${body.length} characters.`,
            { offset, body_chars: body.length },
          );
        }
        let end = Math.min(offset + maxChars, body.length);
        // Never stop between the halves of a surrogate pair, or the next page
        // opens on half an emoji.
        if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1] ?? "")) end -= 1;

        return {
          article: {
            ...(offset === 0
              ? { ...post, title, ...details }
              : { post_id: post.post_id, url: post.url, title }),
            body: body.slice(offset, end),
            body_chars: body.length,
            ...(end < body.length ? { next_offset: end } : {}),
          },
          cost,
        };
      }),
  );

  server.registerTool(
    "x_compare_article",
    {
      title: "X: Compare Article",
      description:
        "Check whether a published X Article still matches its Markdown source — the way to keep " +
        "a blog post and its X copy in sync. Compares the title, then the body paragraph by " +
        "paragraph, ignoring whitespace and curly-versus-straight quotes, and returns only what " +
        "differs, each change anchored to the unchanged paragraph before it. Text only: images, " +
        "links and formatting are not compared. X's API cannot edit a published Article, so " +
        "apply the changes in X's Articles editor. Costs one post read (~$0.005), free if " +
        "x_get_article already read it today.",
      inputSchema: z.object({
        postId: articlePostIdArg,
        markdown: markdownArg,
        markdownPath: markdownPathArg,
        title: titleArg,
        linkBaseUrl: linkBaseUrlArg,
        maxChanges: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe(
            "List at most this many differences (1-200). Defaults to 50; `changes_total` always " +
              "has the full count.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ postId, markdown, markdownPath, title, linkBaseUrl, maxChanges }) =>
      wrap(async () => {
        // Local work first, so a bad path fails before the paid read.
        const source = loadMarkdown({ markdown, markdownPath });
        const conversion = markdownToArticle(source.text, compact({ title, linkBaseUrl }));

        const { items, cost } = await readArticle(postId, "x_compare_article");
        const read = items[0];
        if (!read) return { error: notServed(postId), cost };
        if (!read.article) return { error: notAnArticle(postId), url: read.url, cost };

        const diff = diffParagraphs(
          articleParagraphs(conversion.contentState),
          read.article.body.split("\n"),
        );
        const sameTitle =
          normalizeParagraph(conversion.title ?? "") === normalizeParagraph(read.article.title);
        const hasCode = conversion.contentState.entities.some((e) => e.value.type === "markdown");

        return {
          in_sync: sameTitle && diff.changes.length === 0,
          url: read.url,
          title: sameTitle
            ? { same: true, text: read.article.title }
            : { same: false, source: conversion.title ?? null, x: read.article.title },
          paragraphs: { source: diff.source, x: diff.x, unchanged: diff.unchanged },
          changes: diff.changes.slice(0, maxChanges),
          changes_total: diff.changes.length,
          ...(diff.changes.length > 0
            ? {
                next_step:
                  "X's API cannot edit a published Article: make these edits in X's Articles " +
                  "editor, or publish a replacement from the source and delete the old post.",
              }
            : {}),
          note:
            "Text only — images, links and inline formatting are not compared." +
            (hasCode
              ? " The source's code blocks and tables are not compared either; if X renders " +
                "them into the Article's text, they show up as only_on_x."
              : ""),
          cost,
        };
      }),
  );

  // Everything below creates something on X. Registered only behind the same
  // two flags as x_create_post, so with the defaults these tools do not exist.
  if (!ctx.allowWrites || ctx.writeBackend !== "api") return;

  const uploadImage = async (image: LocalImage): Promise<string> => {
    const res = await client
      .post("/2/media/upload", {
        media: image.bytes.toString("base64"),
        media_category: ARTICLE_IMAGE_CATEGORY,
      })
      .catch(explain(MEDIA_HINT));
    const data = isRecord(res) && isRecord(res.data) ? res.data : undefined;
    const id = typeof data?.id === "string" ? data.id : undefined;
    if (!id) throw new Error(`X accepted ${image.path} but returned no media id.`);
    return id;
  };

  server.registerTool(
    "x_create_article_draft",
    {
      title: "X: Create Article Draft",
      description:
        "Create a DRAFT X Article from Markdown; nothing is public until x_publish_article. " +
        "Converts locally — headings, bold, italic, strikethrough, links, lists, quotes, " +
        "dividers, code blocks and tables; an image or an x.com post link on a line of its own " +
        "becomes an embed — uploads each local image and the optional cover, then creates the " +
        "draft. Run x_validate_article first: it is free and shows what an Article cannot " +
        "express. Needs X Premium on the posting account. X's API cannot edit or delete a draft " +
        "once created, so a correction is a new draft. " +
        UNPRICED,
      inputSchema: z.object({
        markdown: markdownArg,
        markdownPath: markdownPathArg,
        title: titleArg,
        linkBaseUrl: linkBaseUrlArg,
        coverImagePath: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A PNG, JPEG or WebP cover image, up to 5 MB. Absolute, or relative to markdownPath's " +
              "directory. The front matter's `cover` is only used when passed here; " +
              "x_validate_article reports it resolved.",
          ),
        confirm: confirmArg.describe(
          "Must be true. Explicit acknowledgement that this uploads images and creates a draft on X.",
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ markdown, markdownPath, title, linkBaseUrl, coverImagePath }) =>
      wrap(async () => {
        const source = loadMarkdown({ markdown, markdownPath });
        const conversion = markdownToArticle(source.text, compact({ title, linkBaseUrl }));
        const problems = blockingProblems(conversion);
        if (problems.length > 0) throw new PreconditionError(problems.join(" "), { problems });

        // Every file is read and checked before the first upload, so a typo in
        // the last image path fails here rather than after the others were sent.
        const images = conversion.images.map((image) => ({
          entity: image.entity,
          file: readLocalImage(resolveLocalPath(image.src, source.baseDir)),
        }));
        const cover = coverImagePath
          ? readLocalImage(resolveLocalPath(coverImagePath, source.baseDir))
          : undefined;

        // One upload per distinct file: an image placed twice is sent once.
        const uploaded = new Map<string, string>();
        const upload = async (file: LocalImage): Promise<string> => {
          const known = uploaded.get(file.path);
          if (known) return known;
          const id = await uploadImage(file);
          uploaded.set(file.path, id);
          return id;
        };
        const mediaIds = new Map<number, string>();
        for (const image of images) mediaIds.set(image.entity, await upload(image.file));
        const coverId = cover ? await upload(cover) : undefined;

        const resolvedTitle = conversion.title as string;
        const res = await client
          .post("/2/articles/draft", {
            title: resolvedTitle,
            content_state: attachImages(conversion.contentState, mediaIds),
            ...(coverId
              ? { cover_media: { media_id: coverId, media_category: ARTICLE_IMAGE_CATEGORY } }
              : {}),
          })
          .catch(explain(ARTICLE_HINT));

        const data = isRecord(res) && isRecord(res.data) ? res.data : {};
        const articleId = typeof data.id === "string" ? data.id : undefined;
        return {
          drafted: true,
          ...(articleId ? { article_id: articleId } : {}),
          title: typeof data.title === "string" ? data.title : resolvedTitle,
          blocks: conversion.contentState.blocks.length,
          images_uploaded: uploaded.size,
          ...(coverId ? { cover: "uploaded" } : {}),
          warnings: conversion.warnings,
          next_step: articleId
            ? `Nothing is public yet. Review the draft among your Articles on x.com, then call ` +
              `x_publish_article with articleId "${articleId}".`
            : "X returned no draft id; look for the draft among your Articles on x.com.",
          cost: { note: UNPRICED },
        };
      }),
  );

  server.registerTool(
    "x_publish_article",
    {
      title: "X: Publish Article",
      description:
        "Publish a draft Article: it becomes public at once, with a post that carries it. X's " +
        "API has no unpublish and no edit — deleting that post with x_delete_post is the only " +
        "undo. " +
        UNPRICED,
      inputSchema: z.object({
        articleId: z
          .string()
          .regex(/^\d{1,19}$/, "An Article id is 1-19 digits: the article_id a draft returned.")
          .describe(
            'The draft\'s id — the `article_id` from x_create_article_draft, e.g. "1146654567674912769". ' +
              "Not a post id.",
          ),
        confirm: confirmArg.describe(
          "Must be true. Explicit acknowledgement that this publishes publicly on X.",
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ articleId }) =>
      wrap(async () => {
        const res = await client
          .post(`/2/articles/${articleId}/publish`)
          .catch(explain(ARTICLE_HINT));
        const data = isRecord(res) && isRecord(res.data) ? res.data : {};
        const postId = typeof data.post_id === "string" ? data.post_id : undefined;
        return {
          published: true,
          ...(postId
            ? {
                post_id: postId,
                url: `https://x.com/i/web/status/${postId}`,
                next_step: `Read it back with x_get_article, postId "${postId}".`,
              }
            : {}),
          cost: { note: UNPRICED },
        };
      }),
  );
};
