import { PreconditionError } from "#/client/errors";

// A paragraph-level diff for x_compare_article: is the X copy of an Article
// still what its Markdown source says?
//
// Paragraphs, not characters, because the answer has to be something a person
// can act on in X's editor, which has no import: "this paragraph now reads…",
// anchored to the unchanged paragraph before it so it can be found. A longest
// common subsequence over paragraph arrays is exact and small — even a 50,000
// character Article is a few hundred paragraphs — so no dependency is needed.

/**
 * Fold what an editor changes without anyone meaning to: runs of whitespace,
 * non-breaking spaces, curly versus straight quotes, and list markers. Without
 * this, every paragraph X's composer "smartened" would report as rewritten.
 */
export const normalizeParagraph = (text: string): string =>
  text
    .normalize("NFC")
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    // X's plain text writes a list item as "- item"; the source carries the
    // list in the block type instead. Compare the words, not the bullet.
    .replace(/^(?:[-*•]|\d{1,9}[.)]) /, "");

export type ParagraphChange =
  | { kind: "changed"; after?: string; source: string; x: string }
  | { kind: "only_in_source"; after?: string; source: string }
  | { kind: "only_on_x"; after?: string; x: string };

export type ParagraphDiff = {
  /** Non-empty paragraphs on each side, after normalizing. */
  source: number;
  x: number;
  unchanged: number;
  changes: ParagraphChange[];
};

/** Bounds the LCS table (4 bytes a cell), far past any Article. */
const MAX_CELLS = 25_000_000;

const ANCHOR_LENGTH = 80;

const anchorOf = (text: string | undefined): { after?: string } =>
  text === undefined
    ? {}
    : {
        after: text.length > ANCHOR_LENGTH ? `${text.slice(0, ANCHOR_LENGTH - 1)}…` : text,
      };

export const diffParagraphs = (source: readonly string[], x: readonly string[]): ParagraphDiff => {
  const a = source.map(normalizeParagraph).filter(Boolean);
  const b = x.map(normalizeParagraph).filter(Boolean);
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    throw new PreconditionError(`Too large to compare: ${n} source paragraphs against ${m} on X.`, {
      source: n,
      x: m,
    });
  }

  // lcs[i * width + j] is the LCS length of a[i..] and b[j..].
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const changes: ParagraphChange[] = [];
  let unchanged = 0;
  let last: string | undefined;
  let removed: string[] = [];
  let added: string[] = [];

  // A removal and an insertion between the same two unchanged paragraphs are
  // one edit, and read as one: pair them up, and report only the remainder as
  // paragraphs present on a single side.
  const flush = (): void => {
    const anchor = anchorOf(last);
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k += 1) {
      changes.push({
        kind: "changed",
        ...anchor,
        source: removed[k] as string,
        x: added[k] as string,
      });
    }
    for (const text of removed.slice(pairs)) {
      changes.push({ kind: "only_in_source", ...anchor, source: text });
    }
    for (const text of added.slice(pairs)) changes.push({ kind: "only_on_x", ...anchor, x: text });
    removed = [];
    added = [];
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      unchanged += 1;
      last = a[i];
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || at(i, j + 1) >= at(i + 1, j))) {
      added.push(b[j] as string);
      j += 1;
    } else {
      removed.push(a[i] as string);
      i += 1;
    }
  }
  flush();

  return { source: n, x: m, unchanged, changes };
};
