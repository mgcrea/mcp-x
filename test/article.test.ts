import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ARTICLE_MARKDOWN_LIMIT,
  articleParagraphs,
  attachImages,
  markdownToArticle,
} from "#/compose/article";
import { diffParagraphs } from "#/compose/diff";
import {
  MAX_IMAGE_BYTES,
  readLocalImage,
  readMarkdownFile,
  resolveLocalPath,
  sniffImage,
} from "#/compose/image";

/** Pure-function coverage for the Markdown → Article conversion. Nothing here needs a server. */
const blocks = (markdown: string) =>
  markdownToArticle(markdown, { title: "T" }).contentState.blocks;

describe("markdownToArticle blocks", () => {
  it("maps headings, capping h4-h6 at level three with a single warning", () => {
    const res = markdownToArticle("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five", {
      title: "T",
    });
    expect(res.contentState.blocks.map((b) => b.type)).toEqual([
      "header-one",
      "header-two",
      "header-three",
      "header-three",
      "header-three",
    ]);
    expect(res.warnings.filter((w) => w.includes("three heading levels"))).toHaveLength(1);
  });

  it("joins soft-wrapped lines with a space and keeps hard breaks", () => {
    expect(blocks("first line\nsecond line\n\nthird  \nfourth")).toEqual([
      { text: "first line second line", type: "unstyled" },
      { text: "third\nfourth", type: "unstyled" },
    ]);
  });

  it("reads a setext heading as a heading, not as a paragraph and a divider", () => {
    expect(blocks("Intro\n\nTitle\n-----\n\nBody").map((b) => b.type)).toEqual([
      "unstyled",
      "header-two",
      "unstyled",
    ]);
  });

  it("makes one block per list item, flattening nesting with a warning", () => {
    const res = markdownToArticle("- one\n- two\n  continued\n  - nested\n\n1. first\n2) second", {
      title: "T",
    });
    expect(res.contentState.blocks).toEqual([
      { text: "one", type: "unordered-list-item" },
      { text: "two continued", type: "unordered-list-item" },
      { text: "nested", type: "unordered-list-item" },
      { text: "first", type: "ordered-list-item" },
      { text: "second", type: "ordered-list-item" },
    ]);
    expect(res.warnings.some((w) => w.includes("nested lists"))).toBe(true);
  });

  it("joins consecutive quote lines into one blockquote", () => {
    expect(blocks("> a quote\n> that wraps\n\nafter")).toEqual([
      { text: "a quote that wraps", type: "blockquote" },
      { text: "after", type: "unstyled" },
    ]);
  });

  it("turns dividers, code fences and tables into atomic blocks pointing at their entity", () => {
    const md =
      "before\n\n---\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter";
    const { contentState } = markdownToArticle(md, { title: "T" });
    expect(contentState.blocks.map((b) => b.type)).toEqual([
      "unstyled",
      "atomic",
      "atomic",
      "atomic",
      "unstyled",
    ]);
    expect(contentState.blocks[1]).toEqual({
      text: " ",
      type: "atomic",
      entity_ranges: [{ key: 0, offset: 0, length: 1 }],
    });
    expect(contentState.entities).toEqual([
      { key: "0", value: { type: "divider", mutability: "immutable", data: {} } },
      {
        key: "1",
        value: {
          type: "markdown",
          mutability: "mutable",
          data: { markdown: "```ts\nconst a = 1;\n```" },
        },
      },
      {
        key: "2",
        value: {
          type: "markdown",
          mutability: "mutable",
          data: { markdown: "| a | b |\n| - | - |\n| 1 | 2 |" },
        },
      },
    ]);
  });

  it("leaves an image slot to fill, and embeds a standalone post link", () => {
    const md =
      'Intro\n\n![A cover](./img/one.png "The caption")\n\n' +
      "https://x.com/mgcrea/status/2097319903967539446";
    const res = markdownToArticle(md, { title: "T" });
    expect(res.images).toEqual([{ entity: 0, src: "./img/one.png", caption: "The caption" }]);
    expect(res.contentState.entities[0]?.value).toEqual({
      type: "image",
      mutability: "immutable",
      data: { media_items: [], caption: "The caption" },
    });
    expect(res.embeddedPosts).toEqual(["2097319903967539446"]);
    expect(res.contentState.entities[1]?.value).toEqual({
      type: "post",
      mutability: "immutable",
      data: { post_id: "2097319903967539446" },
    });
  });
});

describe("markdownToArticle inline", () => {
  it("records bold, italic and strikethrough as ranges over the plain text", () => {
    expect(blocks("a **bold** and *it* and ~~gone~~")[0]).toEqual({
      text: "a bold and it and gone",
      type: "unstyled",
      inline_style_ranges: [
        { offset: 2, length: 4, style: "bold" },
        { offset: 11, length: 2, style: "italic" },
        { offset: 18, length: 4, style: "strikethrough" },
      ],
    });
  });

  // DraftJS measures in code points. In UTF-16 units the rocket is two long and
  // this range would start at 3, one character late.
  it("measures offsets in code points, so an emoji before a span does not shift it", () => {
    const block = blocks("🚀 **go**")[0];
    expect(block?.text).toBe("🚀 go");
    expect(block?.inline_style_ranges).toEqual([{ offset: 2, length: 2, style: "bold" }]);
  });

  it("nests a style inside a link and points the link's range at its entity", () => {
    const { contentState } = markdownToArticle("see [the **docs**](https://docs.x.com) now", {
      title: "T",
    });
    expect(contentState.blocks[0]).toEqual({
      text: "see the docs now",
      type: "unstyled",
      inline_style_ranges: [{ offset: 8, length: 4, style: "bold" }],
      entity_ranges: [{ key: 0, offset: 4, length: 8 }],
    });
    expect(contentState.entities[0]?.value).toEqual({
      type: "link",
      mutability: "mutable",
      data: { url: "https://docs.x.com" },
    });
  });

  it("links a bare URL without swallowing the sentence's punctuation", () => {
    const { contentState } = markdownToArticle("Read https://example.com/a_(b). Then go.", {
      title: "T",
    });
    expect(contentState.blocks[0]?.text).toBe("Read https://example.com/a_(b). Then go.");
    expect(contentState.entities[0]?.value.data.url).toBe("https://example.com/a_(b)");
    expect(contentState.blocks[0]?.entity_ranges).toEqual([{ key: 0, offset: 5, length: 25 }]);
  });

  it("leaves snake_case names alone", () => {
    expect(blocks("call snake_case_name here")[0]).toEqual({
      text: "call snake_case_name here",
      type: "unstyled",
    });
  });

  it("keeps inline code and a relative link as plain text, warning once for each", () => {
    const res = markdownToArticle("run `pnpm test` and `pnpm lint`, see [docs](/docs)", {
      title: "T",
    });
    expect(res.contentState.blocks[0]).toEqual({
      text: "run pnpm test and pnpm lint, see docs",
      type: "unstyled",
    });
    expect(res.contentState.entities).toEqual([]);
    expect(res.warnings).toHaveLength(2);
  });

  it("keeps escaped delimiters literal", () => {
    expect(blocks("2 \\* 3 = 6 and \\_x\\_")[0]?.text).toBe("2 * 3 = 6 and _x_");
  });

  it("resolves relative links against linkBaseUrl, but never links a bare #fragment", () => {
    const res = markdownToArticle("see [next](/blog/the-blast-radius) and [above](#top)", {
      title: "T",
      linkBaseUrl: "https://mg-crea.com",
    });
    expect(res.contentState.entities.map((e) => e.value.data.url)).toEqual([
      "https://mg-crea.com/blog/the-blast-radius",
    ]);
    expect(res.contentState.blocks[0]?.entity_ranges).toEqual([{ key: 0, offset: 4, length: 4 }]);
    expect(res.warnings.some((w) => w.includes("#fragment"))).toBe(true);
  });
});

describe("markdownToArticle title and front matter", () => {
  const POST = [
    "---",
    "title: The late Software Developer",
    'description: "A quoted: value"',
    "cover: ../../assets/blog/cover.jpg",
    "origin:",
    "  label: Originally posted on X",
    "  href: https://x.com/mgcrea/status/2097319903967539446",
    "---",
    "",
    "It is exciting.",
  ].join("\n");

  it("reads title and cover from the front matter and leaves nested keys alone", () => {
    const res = markdownToArticle(POST);
    expect(res.title).toBe("The late Software Developer");
    expect(res.frontMatter).toEqual({
      title: "The late Software Developer",
      cover: "../../assets/blog/cover.jpg",
    });
    expect(res.contentState.blocks).toEqual([{ text: "It is exciting.", type: "unstyled" }]);
  });

  it("prefers an explicit title over the front matter", () => {
    expect(markdownToArticle(POST, { title: "Override" }).title).toBe("Override");
  });

  it("lifts a leading h1 into the title when nothing else names one", () => {
    const res = markdownToArticle("# Shipping v2\n\nBody.");
    expect(res.title).toBe("Shipping v2");
    expect(res.contentState.blocks).toEqual([{ text: "Body.", type: "unstyled" }]);
  });

  it("drops a leading h1 that only repeats the title", () => {
    const res = markdownToArticle("# Shipping v2\n\nBody.", { title: "Shipping v2" });
    expect(res.contentState.blocks).toHaveLength(1);
    expect(res.warnings.some((w) => w.includes("repeated the title"))).toBe(true);
  });

  it("outlines the headings", () => {
    expect(markdownToArticle("## A\n\ntext\n\n### B", { title: "T" }).outline).toEqual([
      "## A",
      "### B",
    ]);
  });

  it("warns past X's cap on code blocks and tables", () => {
    const res = markdownToArticle(`\`\`\`\n${"x".repeat(ARTICLE_MARKDOWN_LIMIT)}\n\`\`\``, {
      title: "T",
    });
    expect(res.markdownWeightedLength).toBeGreaterThan(ARTICLE_MARKDOWN_LIMIT);
    expect(res.warnings.some((w) => w.includes(String(ARTICLE_MARKDOWN_LIMIT)))).toBe(true);
  });

  it("fills image slots without touching the conversion", () => {
    const res = markdownToArticle("![x](/tmp/a.png)", { title: "T" });
    const filled = attachImages(res.contentState, new Map([[0, "1799"]]));
    expect(filled.entities[0]?.value.data.media_items).toEqual([
      { media_id: "1799", media_category: "tweet_image" },
    ]);
    expect(res.contentState.entities[0]?.value.data.media_items).toEqual([]);
  });

  it("lays the text out one line per entry, skipping atomic blocks", () => {
    const res = markdownToArticle("one\n\n---\n\ntwo  \nthree", { title: "T" });
    expect(articleParagraphs(res.contentState)).toEqual(["one", "two", "three"]);
  });
});

describe("diffParagraphs", () => {
  it("reports nothing for text that differs only in whitespace and quote style", () => {
    const res = diffParagraphs(['It\'s "fine"  here'], ["It’s “fine” here", " "]);
    expect(res.changes).toEqual([]);
    expect(res.unchanged).toBe(1);
  });

  it("pairs a rewrite into one change, anchored to the paragraph before it", () => {
    const res = diffParagraphs(
      ["intro", "new wording", "outro"],
      ["intro", "old wording", "outro"],
    );
    expect(res.changes).toEqual([
      { kind: "changed", after: "intro", source: "new wording", x: "old wording" },
    ]);
  });

  it("reports additions and removals on their own side", () => {
    const res = diffParagraphs(["a", "added", "b"], ["a", "b", "stale"]);
    expect(res.changes).toEqual([
      { kind: "only_in_source", after: "a", source: "added" },
      { kind: "only_on_x", after: "b", x: "stale" },
    ]);
  });

  it("keeps the anchor short enough to search for", () => {
    const res = diffParagraphs(["x".repeat(200), "new"], ["x".repeat(200), "old"]);
    expect(res.changes[0]?.after).toHaveLength(80);
  });

  it("ignores the list marker X's plain text puts before an item", () => {
    expect(diffParagraphs(["Bastion, which runs"], ["- Bastion, which runs"]).changes).toEqual([]);
    expect(diffParagraphs(["first"], ["1. first"]).changes).toEqual([]);
  });
});

describe("local files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-x-article-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("recognises images by content, not by name", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(Buffer.from("GIF89a"))).toBe("gif");
    expect(sniffImage(Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBeUndefined();
  });

  // The point of sniffing: a model talked into "uploading" a key file named
  // like an image must get a refusal, never a request.
  it("refuses a non-image even when it is named like one", () => {
    const path = join(dir, "id_ed25519.png");
    writeFileSync(path, "-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(() => readLocalImage(path)).toThrow(/not a PNG, JPEG or WebP/);
  });

  it("refuses a GIF, and an oversized file", () => {
    const gif = join(dir, "a.gif");
    writeFileSync(gif, "GIF89a....");
    expect(() => readLocalImage(gif)).toThrow(/GIF/);
    const big = join(dir, "big.png");
    writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(() => readLocalImage(big)).toThrow(/5 MB/);
  });

  it("resolves relative image paths against the Markdown file, and refuses remote URLs", () => {
    expect(resolveLocalPath("../../assets/c.jpg", "/site/src/content/blog")).toBe(
      "/site/src/assets/c.jpg",
    );
    expect(resolveLocalPath("/abs/a%20b.png")).toBe("/abs/a b.png");
    expect(() => resolveLocalPath("img.png")).toThrow(/markdownPath/);
    expect(() => resolveLocalPath("https://example.com/a.png")).toThrow(/remote URL/);
  });

  it("reads Markdown only from an absolute path with a Markdown extension", () => {
    const md = join(dir, "post.md");
    writeFileSync(md, "# Hi");
    expect(readMarkdownFile(md).text).toBe("# Hi");
    expect(() => readMarkdownFile("post.md")).toThrow(/absolute/);
    const other = join(dir, "notes.txt");
    writeFileSync(other, "x");
    expect(() => readMarkdownFile(other)).toThrow(/\.md/);
  });
});
