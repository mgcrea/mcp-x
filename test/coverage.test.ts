import { describe, expect, it, vi } from "vitest";

import { buildSearchQuery } from "#/tools/search";

/**
 * Pure-function coverage for paths the tool tests only touched at the
 * registration level. Nothing here needs a server.
 */
describe("buildSearchQuery operators", () => {
  it("quotes a multi-word exclusion so it excludes the phrase, not half of it", () => {
    // `-machine learning` excludes "machine" and then *requires* "learning".
    const { query } = buildSearchQuery({ noneWords: ["machine learning", "spam"] });
    expect(query).toBe('-"machine learning" -spam');
  });

  it("drops an embedded double quote rather than emitting a query X cannot parse", () => {
    const { query } = buildSearchQuery({ exactPhrase: 'say "hi"' });
    expect(query).toBe('"say hi"');
  });

  it("quotes multi-word alternatives and skips the parentheses for a single one", () => {
    expect(buildSearchQuery({ anyWords: ["rust lang", "go"] }).query).toBe('("rust lang" OR go)');
    expect(buildSearchQuery({ anyWords: ["rust"] }).query).toBe("rust");
  });

  it("emits every operator in X's own syntax", () => {
    const { query, explanation } = buildSearchQuery({
      allWords: "async runtime",
      hashtags: ["rust", "#tokio"],
      from: ["@a", "b"],
      to: ["c"],
      mentioning: ["@d"],
      lang: "en",
      hasMedia: true,
      hasLinks: false,
      isReply: false,
      isRetweet: false,
      isQuote: true,
    });
    expect(query).toBe(
      "async runtime #rust #tokio (from:a OR from:b) to:c @d lang:en has:media -has:links " +
        "-is:reply -is:retweet is:quote",
    );
    // One line per clause, and the two hashtags are two clauses.
    expect(explanation).toHaveLength(12);
  });

  it("calls a query valid only up to the 512-character Basic/Pro limit", () => {
    const long = buildSearchQuery({ allWords: "a".repeat(600) });
    expect(long.valid).toBe(false);
    expect(long.warning).toMatch(/512/);
    expect(buildSearchQuery({ allWords: "a".repeat(500) }).valid).toBe(true);
  });
});

describe("openInBrowser", () => {
  it("returns the failure reason rather than throwing when the opener command fails", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("spawn open ENOENT")),
    }));
    // Not in Docker, and — on Linux, where CI runs — not headless either.
    // Without a display the opener short-circuits before it spawns anything,
    // so this asserted nothing on Linux while passing on macOS.
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    vi.stubEnv("DISPLAY", ":0");
    try {
      const { openInBrowser } = await import("#/compose/open");
      const res = await openInBrowser("https://x.com/intent/tweet?text=hi");
      expect(res.opened).toBe(false);
      expect(res.reason).toMatch(/ENOENT/);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
    }
  });

  it("reports a headless environment instead of trying to spawn a browser", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => true })); // /.dockerenv
    try {
      const { openInBrowser } = await import("#/compose/open");
      const res = await openInBrowser("https://x.com/intent/tweet?text=hi");
      expect(res).toEqual({
        opened: false,
        reason: "headless environment — open the URL yourself",
      });
    } finally {
      vi.doUnmock("node:fs");
    }
  });

  it("refuses to open anything that is not X, whatever the model asked for", async () => {
    vi.resetModules();
    const { openInBrowser } = await import("#/compose/open");
    const res = await openInBrowser("https://evil.example/phish");
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/non-X origin/);
  });
});
