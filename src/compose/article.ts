import { weightedLength } from "#/compose/weighted";

// X Articles take their body as a DraftJS "raw content state": a flat list of
// blocks — one per paragraph, heading, list item or quote, each carrying its
// own inline style ranges — plus a side table of entities (links, images,
// embedded posts, dividers, code) that blocks point into by index.
//
// Nobody should have to hand-write that, and a model asked to will get the
// offsets wrong. This module turns ordinary Markdown into it, locally and
// without a request, so the free preview (x_validate_article) and the draft
// (x_create_article_draft) share one conversion and cannot disagree.
//
// What an Article cannot express, and what happens to it here — each one
// reported once in `warnings`, never dropped silently:
//
//  - h4-h6. There are three heading levels; deeper ones become level three.
//  - Nested lists. X's block schema has no depth, so they are flattened.
//  - Inline code. There is no code style: the text stays, the backticks go.
//  - Code blocks and tables are NOT lost. X renders them from a `markdown`
//    entity on an atomic block, capped at 10,000 weighted characters per
//    Article in total.
//  - Images. An `image` entity needs a media id, which only exists after an
//    upload. The conversion leaves the slot empty and lists each source in
//    `images`; the caller uploads them and calls `attachImages`.
//
// Offsets are counted in Unicode code points, not UTF-16 code units. That is
// the DraftJS raw format's own convention (its converters measure with
// UnicodeUtils.strlen), and it is the opposite of what `shape.ts` needs for
// X's post entities — so the two modules are right to disagree. An emoji
// before a bold span is exactly where getting this wrong shows.

/** X's own cap on markdown entities (code blocks, tables), per Article. */
export const ARTICLE_MARKDOWN_LIMIT = 10_000;

/** The only media category Article images accept; GIFs and videos are refused. */
export const ARTICLE_IMAGE_CATEGORY = "tweet_image";

export type ArticleBlockType =
  | "unstyled"
  | "header-one"
  | "header-two"
  | "header-three"
  | "unordered-list-item"
  | "ordered-list-item"
  | "blockquote"
  | "atomic";

export type ArticleInlineStyle = "bold" | "italic" | "strikethrough";

export type ArticleStyleRange = { offset: number; length: number; style: ArticleInlineStyle };

/** `key` is an index into `entities`, not the entity's own string key. */
export type ArticleEntityRange = { key: number; offset: number; length: number };

export type ArticleBlock = {
  text: string;
  type: ArticleBlockType;
  inline_style_ranges?: ArticleStyleRange[];
  entity_ranges?: ArticleEntityRange[];
};

export type ArticleEntityData = {
  url?: string;
  post_id?: string;
  markdown?: string;
  caption?: string;
  media_items?: { media_id: string; media_category: string }[];
};

export type ArticleEntity = {
  key: string;
  value: {
    type: "link" | "post" | "image" | "markdown" | "divider";
    mutability: "mutable" | "immutable";
    data: ArticleEntityData;
  };
};

export type ArticleContentState = { blocks: ArticleBlock[]; entities: ArticleEntity[] };

/** An image the body places on its own line, still to be uploaded. */
export type ArticleImageRef = {
  /** Index into `entities` of the image slot to fill. */
  entity: number;
  /** The source exactly as written in the Markdown. */
  src: string;
  caption?: string;
};

export type ArticleConversion = {
  /** The title to publish under: the explicit one, the front matter's, or a leading `# Heading`. */
  title?: string;
  frontMatter: { title?: string; cover?: string };
  contentState: ArticleContentState;
  images: ArticleImageRef[];
  /** Ids of the posts embedded from standalone x.com status links. */
  embeddedPosts: string[];
  /** The headings, as Markdown, so a preview reads as a table of contents. */
  outline: string[];
  /** Weighted length of every code block and table together, against ARTICLE_MARKDOWN_LIMIT. */
  markdownWeightedLength: number;
  warnings: string[];
};

type Doc = {
  blocks: ArticleBlock[];
  entities: ArticleEntity[];
  images: ArticleImageRef[];
  embeddedPosts: string[];
  /** Keyed by a code, so a document with forty nested lists warns once, not forty times. */
  warnings: Map<string, string>;
  /** The site relative links were written for. Without it they keep their text and lose the link. */
  linkBase?: string | undefined;
};

const warn = (doc: Doc, code: string, message: string): void => {
  if (!doc.warnings.has(code)) doc.warnings.set(code, message);
};

// --- Inline -----------------------------------------------------------------

type Sink = {
  text: string;
  /** Length of `text` in code points — the unit every range is measured in. */
  length: number;
  styles: ArticleStyleRange[];
  ranges: ArticleEntityRange[];
};

const newSink = (): Sink => ({ text: "", length: 0, styles: [], ranges: [] });

const append = (sink: Sink, text: string): void => {
  if (!text) return;
  sink.text += text;
  sink.length += [...text].length;
};

const addEntity = (doc: Doc, value: ArticleEntity["value"]): number => {
  const index = doc.entities.length;
  // The string key and the array index are kept equal: entity_ranges refer to
  // the index, and a reader cross-checking against `key` should find the same.
  doc.entities.push({ key: String(index), value });
  return index;
};

const ABSOLUTE_LINK = /^(?:https?:|mailto:)/i;

/**
 * A link as X can follow it: absolute as written, or relative resolved against
 * the site it was written for. A blog post links its siblings as `/blog/next`,
 * which on X points nowhere. A bare `#fragment` names a spot on a page that does
 * not exist on X, so it is never linked, base or not.
 */
const absoluteLink = (url: string, base: string | undefined): string | undefined => {
  if (ABSOLUTE_LINK.test(url)) return url;
  if (!base || url.startsWith("#")) return undefined;
  try {
    const resolved = new URL(url, base);
    return resolved.protocol === "https:" || resolved.protocol === "http:"
      ? resolved.href
      : undefined;
  } catch {
    return undefined;
  }
};

const addLink = (sink: Sink, doc: Doc, start: number, url: string): void => {
  if (sink.length === start) return;
  const href = absoluteLink(url, doc.linkBase);
  if (!href) {
    warn(
      doc,
      "relative-link",
      "A relative or #fragment link cannot resolve outside the site it was written for, so its " +
        "text was kept without the link. Pass linkBaseUrl, the site's address, to resolve " +
        "relative ones.",
    );
    return;
  }
  const key = addEntity(doc, { type: "link", mutability: "mutable", data: { url: href } });
  sink.ranges.push({ key, offset: start, length: sink.length - start });
};

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const BACKTICKS = /`+/y;
const AUTOLINK = /<(https?:\/\/[^\s>]+)>/y;
const BARE_URL = /https?:\/\/[^\s<>]+/y;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

/** Trailing punctuation belongs to the sentence, not to the URL it ends. */
const trimUrl = (url: string): string => {
  let out = url;
  for (;;) {
    const next = out.replace(/[.,;:!?'"*_~]+$/, "");
    const opens = next.split("(").length - 1;
    const closes = next.split(")").length - 1;
    const trimmed = next.endsWith(")") && closes > opens ? next.slice(0, -1) : next;
    if (trimmed === out) return out;
    out = trimmed;
  }
};

type LinkMatch = { label: string; url: string; title?: string; end: number };

/** `[label](url "title")`, where `start` is the index of the `[`. */
const matchLink = (src: string, start: number): LinkMatch | undefined => {
  let depth = 0;
  let close = start;
  for (; close < src.length; close += 1) {
    const ch = src[close];
    if (ch === "\\") {
      close += 1;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[close + 1] !== "(") return undefined;

  let end = close + 2;
  let parens = 1;
  for (; end < src.length; end += 1) {
    const ch = src[end];
    if (ch === "\\") {
      end += 1;
    } else if (ch === "(") {
      parens += 1;
    } else if (ch === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  if (parens !== 0) return undefined;

  const destination = /^<?([^\s>]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?$/.exec(
    src.slice(close + 2, end).trim(),
  );
  const url = destination?.[1];
  if (!url) return undefined;
  const title = destination[2] ?? destination[3];
  return { label: src.slice(start + 1, close), url, ...(title ? { title } : {}), end: end + 1 };
};

const DELIMITERS: readonly (readonly [string, ArticleInlineStyle])[] = [
  ["**", "bold"],
  ["__", "bold"],
  ["~~", "strikethrough"],
  ["*", "italic"],
  ["_", "italic"],
];

/**
 * A pragmatic subset of CommonMark emphasis: an opener not followed by space,
 * a closer not preceded by one, and `_` never inside a word — so
 * `snake_case_name` stays text, which is the case that matters in technical
 * writing.
 */
const matchEmphasis = (
  src: string,
  start: number,
): { inner: string; style: ArticleInlineStyle; end: number } | undefined => {
  for (const [delim, style] of DELIMITERS) {
    if (!src.startsWith(delim, start)) continue;
    const open = start + delim.length;
    const first = src[open];
    if (first === undefined || SPACE.test(first)) continue;
    const underscore = delim.startsWith("_");
    if (underscore && WORD.test(src[start - 1] ?? "")) continue;

    for (
      let close = src.indexOf(delim, open + 1);
      close !== -1;
      close = src.indexOf(delim, close + 1)
    ) {
      const before = src[close - 1] ?? "";
      const after = src[close + delim.length] ?? "";
      if (SPACE.test(before) || before === "\\") continue;
      // A lone `*` that is half of a `**` belongs to the bold, not to this italic.
      if (delim.length === 1 && (after === delim || before === delim)) continue;
      if (underscore && WORD.test(after)) continue;
      return { inner: src.slice(open, close), style, end: close + delim.length };
    }
  }
  return undefined;
};

const parseInline = (src: string, sink: Sink, doc: Doc): void => {
  let plain = "";
  const flush = (): void => {
    append(sink, plain);
    plain = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;

    if (ch === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      plain += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      BACKTICKS.lastIndex = i;
      const run = BACKTICKS.exec(src)?.[0] ?? "`";
      const close = src.indexOf(run, i + run.length);
      if (close === -1) {
        plain += run;
        i += run.length;
        continue;
      }
      plain += src.slice(i + run.length, close).replace(/^ (.+) $/s, "$1");
      warn(
        doc,
        "inline-code",
        "Inline code has no style in an X Article, so it became plain text. Put code worth " +
          "formatting in a fenced block, which is kept.",
      );
      i = close + run.length;
      continue;
    }

    if (ch === "!" && src[i + 1] === "[") {
      const image = matchLink(src, i + 1);
      if (image) {
        plain += image.label;
        warn(
          doc,
          "inline-image",
          "An image inside a paragraph cannot be placed in an X Article, so only its alt text " +
            "was kept. Put the image on a line of its own.",
        );
        i = image.end;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLink(src, i);
      if (link) {
        flush();
        const start = sink.length;
        parseInline(link.label, sink, doc);
        addLink(sink, doc, start, link.url);
        i = link.end;
        continue;
      }
    }

    if (ch === "<") {
      AUTOLINK.lastIndex = i;
      const auto = AUTOLINK.exec(src);
      if (auto?.[1]) {
        flush();
        const start = sink.length;
        append(sink, auto[1]);
        addLink(sink, doc, start, auto[1]);
        i += auto[0].length;
        continue;
      }
    }

    if (ch === "h" && !/[\w/]/.test(src[i - 1] ?? "")) {
      BARE_URL.lastIndex = i;
      const bare = BARE_URL.exec(src);
      if (bare) {
        const url = trimUrl(bare[0]);
        flush();
        const start = sink.length;
        append(sink, url);
        addLink(sink, doc, start, url);
        i += url.length;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const emphasis = matchEmphasis(src, i);
      if (emphasis) {
        flush();
        const start = sink.length;
        parseInline(emphasis.inner, sink, doc);
        if (sink.length > start) {
          sink.styles.push({ offset: start, length: sink.length - start, style: emphasis.style });
        }
        i = emphasis.end;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }
  flush();
};

// --- Blocks -----------------------------------------------------------------

const textBlock = (doc: Doc, type: ArticleBlockType, markdown: string): void => {
  const sink = newSink();
  parseInline(markdown, sink, doc);
  if (sink.text.trim() === "") return;
  doc.blocks.push({
    text: sink.text,
    type,
    ...(sink.styles.length > 0 ? { inline_style_ranges: sink.styles } : {}),
    ...(sink.ranges.length > 0 ? { entity_ranges: sink.ranges } : {}),
  });
};

/** An atomic block is a single-space placeholder whose one character carries the entity. */
const atomic = (doc: Doc, value: ArticleEntity["value"]): number => {
  const key = addEntity(doc, value);
  doc.blocks.push({ text: " ", type: "atomic", entity_ranges: [{ key, offset: 0, length: 1 }] });
  return key;
};

const HEADING_TYPES = ["header-one", "header-two", "header-three"] as const;

const heading = (doc: Doc, level: number, text: string): void => {
  if (level > 3) {
    warn(doc, "deep-heading", "X Articles have three heading levels; h4-h6 became level three.");
  }
  textBlock(doc, HEADING_TYPES[Math.min(level, 3) - 1] ?? "header-three", text);
};

/** Soft-wrapped lines join with a space; a trailing backslash or two spaces is a real line break. */
const joinLines = (lines: readonly string[]): string => {
  let out = "";
  lines.forEach((raw, index) => {
    const hard = / {2,}$/.test(raw) || raw.endsWith("\\");
    out += raw.trim().replace(/\\$/, "");
    if (index < lines.length - 1) out += hard ? "\n" : " ";
  });
  return out;
};

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;

/**
 * One top-level `key: value` line. Deliberately not a YAML parser: two scalar
 * fields do not justify a dependency (this server has two, on purpose), and a
 * nested value or a block scalar is simply not taken rather than misread.
 */
const frontMatterScalar = (yaml: string, key: string): string | undefined => {
  const match = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(yaml);
  let value = match?.[1];
  if (!value || /^[|>]/.test(value)) return undefined;
  if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
  return value || undefined;
};

const splitFrontMatter = (
  text: string,
): { frontMatter: ArticleConversion["frontMatter"]; body: string } => {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { frontMatter: {}, body: text };
  const yaml = match[1] ?? "";
  const title = frontMatterScalar(yaml, "title");
  const cover = frontMatterScalar(yaml, "cover");
  return {
    frontMatter: { ...(title ? { title } : {}), ...(cover ? { cover } : {}) },
    body: text.slice(match[0].length),
  };
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const ORDERED = /^([ \t]*)\d{1,9}[.)][ \t]+(.*)$/;
const IMAGE_LINE =
  /^ {0,3}!\[([^\]]*)\]\([ \t]*<?([^\s>)]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?[ \t]*\)[ \t]*$/;
const POST_LINE =
  /^ {0,3}<?https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:i\/web|[A-Za-z0-9_]{1,15})\/status\/(\d{1,19})(?:[/?#][^\s>]*)?>?[ \t]*$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;
const HTML_LINE = /^ {0,3}<\/?[A-Za-z][^>]*>/;

/**
 * Convert Markdown to an X Article's content state.
 *
 * `title` wins over the front matter's, which wins over a leading `# Heading`.
 * A leading heading that repeats the title is removed from the body, because X
 * already renders the title above it.
 */
export const markdownToArticle = (
  markdown: string,
  opts: { title?: string; linkBaseUrl?: string } = {},
): ArticleConversion => {
  const doc: Doc = {
    blocks: [],
    entities: [],
    images: [],
    embeddedPosts: [],
    warnings: new Map(),
    linkBase: opts.linkBaseUrl,
  };
  const { frontMatter, body } = splitFrontMatter(markdown.replace(/\r\n?/g, "\n"));
  const lines = body.split("\n");

  let paragraph: string[] = [];
  let quote: string[] = [];
  let item: { type: "unordered-list-item" | "ordered-list-item"; text: string } | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) textBlock(doc, "unstyled", joinLines(paragraph));
    paragraph = [];
  };
  const flushQuote = (): void => {
    if (quote.length > 0) textBlock(doc, "blockquote", joinLines(quote));
    quote = [];
  };
  const flushItem = (): void => {
    if (item) textBlock(doc, item.type, item.text);
    item = undefined;
  };
  const flushAll = (): void => {
    flushParagraph();
    flushQuote();
    flushItem();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const marker = fence[1] as string;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      const code = [line.trimStart()];
      let j = i + 1;
      for (; j < lines.length && !closing.test(lines[j] as string); j += 1) {
        code.push(lines[j] as string);
      }
      if (j < lines.length) {
        code.push((lines[j] as string).trim());
      } else {
        code.push(marker);
        warn(doc, "unclosed-fence", "A code block was never closed, so it runs to the end.");
      }
      atomic(doc, { type: "markdown", mutability: "mutable", data: { markdown: code.join("\n") } });
      i = j;
      continue;
    }

    // `Title\n---` is a heading, not a paragraph followed by a divider.
    const setext = paragraph.length > 0 && !item && quote.length === 0 ? SETEXT.exec(line) : null;
    if (setext) {
      const text = joinLines(paragraph);
      paragraph = [];
      heading(doc, (setext[1] as string).startsWith("=") ? 1 : 2, text);
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      atomic(doc, { type: "divider", mutability: "immutable", data: {} });
      continue;
    }

    const title = HEADING.exec(line);
    if (title) {
      flushAll();
      heading(doc, (title[1] as string).length, title[2] ?? "");
      continue;
    }

    const image = IMAGE_LINE.exec(line);
    if (image) {
      flushAll();
      const caption = image[3] ?? image[4];
      const entity = atomic(doc, {
        type: "image",
        mutability: "immutable",
        data: { media_items: [], ...(caption ? { caption } : {}) },
      });
      doc.images.push({ entity, src: image[2] as string, ...(caption ? { caption } : {}) });
      continue;
    }

    const post = POST_LINE.exec(line);
    if (post) {
      flushAll();
      const postId = post[1] as string;
      atomic(doc, { type: "post", mutability: "immutable", data: { post_id: postId } });
      doc.embeddedPosts.push(postId);
      continue;
    }

    if (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flushAll();
      const rows = [line, lines[i + 1] as string];
      let j = i + 2;
      for (; j < lines.length && (lines[j] as string).includes("|"); j += 1) {
        if ((lines[j] as string).trim() === "") break;
        rows.push(lines[j] as string);
      }
      atomic(doc, { type: "markdown", mutability: "mutable", data: { markdown: rows.join("\n") } });
      i = j - 1;
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      flushItem();
      const content = (quoted[1] ?? "").replace(/^(?:[ \t]*>[ \t]?)+/, "");
      if (content.trim() === "") flushQuote();
      else quote.push(content);
      continue;
    }

    const listed = BULLET.exec(line) ?? ORDERED.exec(line);
    if (listed) {
      flushAll();
      if ((listed[1] ?? "").replace(/\t/g, "    ").length >= 2) {
        warn(
          doc,
          "nested-list",
          "X Articles have no nested lists, so indented items were flattened to the top level.",
        );
      }
      item = {
        type: BULLET.test(line) ? "unordered-list-item" : "ordered-list-item",
        text: listed[2] ?? "",
      };
      continue;
    }

    // Lazy continuation: an unmarked line straight after an item or a quote
    // still belongs to it, as CommonMark reads it.
    if (item) {
      item.text += ` ${line.trim()}`;
      continue;
    }
    if (quote.length > 0) {
      quote.push(line);
      continue;
    }

    if (HTML_LINE.test(line)) {
      warn(doc, "html", "Raw HTML has no equivalent in an X Article, so it was kept as text.");
    }
    paragraph.push(line);
  }
  flushAll();

  let resolvedTitle = opts.title ?? frontMatter.title;
  const first = doc.blocks[0];
  // Only a heading with no link in it is lifted: removing a block that owns an
  // entity range would leave that entity orphaned in the table.
  if (first?.type === "header-one" && !first.entity_ranges) {
    if (resolvedTitle === undefined) {
      resolvedTitle = first.text;
      doc.blocks.shift();
    } else if (first.text.trim() === resolvedTitle.trim()) {
      doc.blocks.shift();
      warn(
        doc,
        "duplicate-title",
        "The leading heading repeated the title, so it was removed: X shows the title above the " +
          "body already.",
      );
    }
  }

  const markdownWeightedLength = doc.entities.reduce(
    (sum, entity) =>
      entity.value.type === "markdown" && entity.value.data.markdown
        ? sum + weightedLength(entity.value.data.markdown).weighted
        : sum,
    0,
  );
  if (markdownWeightedLength > ARTICLE_MARKDOWN_LIMIT) {
    warn(
      doc,
      "markdown-limit",
      `Code blocks and tables add up to ${markdownWeightedLength} weighted characters; X caps them ` +
        `at ${ARTICLE_MARKDOWN_LIMIT} per Article and will refuse the draft.`,
    );
  }

  const outline = doc.blocks.flatMap((block) => {
    const level = HEADING_TYPES.indexOf(block.type as (typeof HEADING_TYPES)[number]);
    return level === -1 ? [] : [`${"#".repeat(level + 1)} ${block.text}`];
  });

  return {
    ...(resolvedTitle ? { title: resolvedTitle } : {}),
    frontMatter,
    contentState: { blocks: doc.blocks, entities: doc.entities },
    images: doc.images,
    embeddedPosts: doc.embeddedPosts,
    outline,
    markdownWeightedLength,
    warnings: [...doc.warnings.values()],
  };
};

/**
 * The body's text one line per entry, laid out the way X's own `plain_text`
 * is: atomic blocks (images, dividers, code, embeds) carry no text, and a hard
 * line break inside a block is a line of its own.
 */
export const articleParagraphs = (state: ArticleContentState): string[] =>
  state.blocks
    .filter((block) => block.type !== "atomic")
    .flatMap((block) => block.text.split("\n"));

/**
 * Fill image slots with uploaded media ids, keyed by entity index. Returns a
 * new content state; the conversion is left untouched, so a preview and a
 * failed upload never see a half-filled one.
 */
export const attachImages = (
  state: ArticleContentState,
  mediaIds: ReadonlyMap<number, string>,
): ArticleContentState => ({
  blocks: state.blocks,
  entities: state.entities.map((entity, index) => {
    const mediaId = mediaIds.get(index);
    if (mediaId === undefined) return entity;
    return {
      ...entity,
      value: {
        ...entity.value,
        data: {
          ...entity.value.data,
          media_items: [{ media_id: mediaId, media_category: ARTICLE_IMAGE_CATEGORY }],
        },
      },
    };
  }),
});
