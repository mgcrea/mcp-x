// X answers with a `data` / `includes` / `meta` triple. The interesting parts of
// a post — who wrote it, what it quotes, where its t.co links actually go —
// are not in `data` at all; they sit in a sidecar `includes` array keyed by id.
//
// Handing that to a model raw does two bad things: it spends a large multiple of
// the tokens the content is worth, and it makes the model perform a join
// (author_id → includes.users[].id) that it can silently get wrong. So every
// read tool returns posts that already have their author, quoted post, media and
// expanded URLs inlined, and `includes` is never returned at all.

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Three lookup tables built once per response. */
export type Includes = {
  users: Map<string, Rec>;
  tweets: Map<string, Rec>;
  media: Map<string, Rec>;
};

const indexBy = (items: unknown, key: string): Map<string, Rec> => {
  const map = new Map<string, Rec>();
  if (!Array.isArray(items)) return map;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = str(item[key]);
    if (id) map.set(id, item);
  }
  return map;
};

/**
 * Build the lookup tables from one `includes` block or several (paginated reads
 * return one per page).
 *
 * These are `Map`s rather than an `Array.find` per lookup on purpose: a 100-post
 * page with 100 distinct authors would otherwise be quadratic, and the whole
 * point of this module is that it stays cheap on the largest responses.
 */
export const buildIncludesIndex = (includes: Rec | Rec[] | undefined): Includes => {
  const blocks = Array.isArray(includes) ? includes : includes ? [includes] : [];
  const index: Includes = { users: new Map(), tweets: new Map(), media: new Map() };
  for (const block of blocks) {
    for (const [id, user] of indexBy(block.users, "id")) index.users.set(id, user);
    for (const [id, tweet] of indexBy(block.tweets, "id")) index.tweets.set(id, tweet);
    for (const [key, media] of indexBy(block.media, "media_key")) index.media.set(key, media);
  }
  return index;
};

/** Pull the `includes` block out of a raw response envelope. */
export const includesOf = (response: unknown): Rec | undefined =>
  isRecord(response) && isRecord(response.includes) ? response.includes : undefined;

/**
 * "@handle (Display Name)" in one field, because the model reads it as a name
 * and never has to look one up. An unresolved author degrades rather than
 * throwing — a deleted or suspended account is routine, not exceptional.
 */
const formatAuthor = (authorId: string | undefined, index: Includes): string => {
  if (!authorId) return "@unknown";
  const user = index.users.get(authorId);
  const username = user ? str(user.username) : undefined;
  if (!username) return `@unknown (id ${authorId})`;
  const name = user ? str(user.name) : undefined;
  return name ? `@${username} (${name})` : `@${username}`;
};

const postUrl = (authorId: string | undefined, id: string, index: Includes): string => {
  const username = authorId ? str(index.users.get(authorId)?.username) : undefined;
  // `i/web` is X's own canonical fallback and redirects correctly, so an
  // unresolved author still yields a link that works.
  return `https://x.com/${username ?? "i/web"}/status/${id}`;
};

/**
 * Replace each t.co link with where it actually points.
 *
 * Splices run right-to-left by `start` so earlier offsets stay valid as the
 * string changes length. The offsets are UTF-16 code units, which is exactly
 * what `String.prototype.slice` counts — no conversion needed. That is worth
 * saying out loud, because "fixing" this to use code points is a natural-looking
 * change that would corrupt every post containing an emoji.
 */
const expandUrls = (text: string, raw: Rec): string => {
  const entities = isRecord(raw.entities) ? raw.entities : undefined;
  const urls = entities && Array.isArray(entities.urls) ? entities.urls : [];
  const spans = urls
    .filter(isRecord)
    .map((u) => ({
      start: num(u.start),
      end: num(u.end),
      expanded: str(u.expanded_url) ?? str(u.url),
    }))
    .filter(
      (u): u is { start: number; end: number; expanded: string } =>
        u.start !== undefined && u.end !== undefined && u.expanded !== undefined,
    )
    .toSorted((a, b) => b.start - a.start);

  let out = text;
  for (const span of spans) {
    if (span.start < 0 || span.end > out.length || span.start > span.end) continue;
    out = out.slice(0, span.start) + span.expanded + out.slice(span.end);
  }
  return out;
};

/**
 * The full text of a post, which for a long-form post is NOT `text`.
 *
 * X caps `text` at 280 characters however long the post really is — a Premium
 * account can write 25,000 — and puts the whole thing in `note_tweet.text`,
 * returned only when `note_tweet` is named in `tweet.fields`. Reading `text`
 * alone silently truncates, which looks like a post that happens to end in an
 * ellipsis rather than like a bug.
 *
 * The entities are taken from the note as well, never from the post. That is
 * the part worth being careful about: `expandUrls` splices by offset, and the
 * top-level `entities.urls` offsets are indices into the TRUNCATED text. Reused
 * against the longer string they land in range and in the wrong place, so the
 * bounds check above waves them through and the content is corrupted rather
 * than left alone. A note whose own entities carry no urls simply keeps its
 * t.co links, which is the right way to be wrong here.
 */
const fullText = (raw: Rec): string => {
  const note = isRecord(raw.note_tweet) ? raw.note_tweet : undefined;
  const noteText = note ? str(note.text) : undefined;
  if (note && noteText) return expandUrls(noteText, note);
  return expandUrls(str(raw.text) ?? "", raw);
};

const shapeMedia = (raw: Rec, index: Includes): string[] | undefined => {
  const attachments = isRecord(raw.attachments) ? raw.attachments : undefined;
  const keys = attachments && Array.isArray(attachments.media_keys) ? attachments.media_keys : [];
  const items: string[] = [];
  for (const key of keys) {
    const k = str(key);
    if (!k) continue;
    const media = index.media.get(k);
    if (!media) {
      items.push(`media (not expanded): ${k}`);
      continue;
    }
    const type = str(media.type) ?? "media";
    // Videos and GIFs carry `preview_image_url`; photos carry `url`.
    const url = str(media.url) ?? str(media.preview_image_url);
    const alt = str(media.alt_text);
    items.push(`${type}${url ? `: ${url}` : ""}${alt ? ` (alt: ${alt})` : ""}`);
  }
  return items.length > 0 ? items : undefined;
};

const shapeMetrics = (raw: Rec): ShapedPost["metrics"] => {
  const m = isRecord(raw.public_metrics) ? raw.public_metrics : undefined;
  if (!m) return undefined;
  const metrics = {
    likes: num(m.like_count),
    reposts: num(m.retweet_count),
    replies: num(m.reply_count),
    quotes: num(m.quote_count),
    views: num(m.impression_count),
  };
  const entries = Object.entries(metrics).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as ShapedPost["metrics"]) : undefined;
};

/** A referenced post, resolved one level deep only. */
export type ShapedRef = {
  id: string;
  author?: string;
  text?: string;
  created_at?: string;
};

export type ShapedPost = {
  id: string;
  url: string;
  author: string;
  created_at?: string;
  text: string;
  lang?: string;
  metrics?: { likes?: number; reposts?: number; replies?: number; quotes?: number; views?: number };
  quotes?: ShapedRef;
  replies_to?: ShapedRef;
  reposts?: ShapedRef;
  media?: string[];
  conversation_id?: string;
};

/**
 * Resolve one referenced post from `includes.tweets`. Deliberately one hop and
 * no recursion: X only sideloads a single level anyway, and a
 * quote-of-a-quote-of-a-quote expanded in place is a context-window bomb for no
 * added meaning.
 */
const shapeRef = (id: string, index: Includes): ShapedRef => {
  const raw = index.tweets.get(id);
  if (!raw) return { id }; // deleted, protected, or simply not requested
  const text = fullText(raw);
  const authorId = str(raw.author_id);
  return {
    id,
    ...(authorId ? { author: formatAuthor(authorId, index) } : {}),
    ...(text ? { text } : {}),
    ...(str(raw.created_at) ? { created_at: str(raw.created_at) } : {}),
  };
};

export const shapePost = (raw: Rec, index: Includes): ShapedPost => {
  const id = str(raw.id) ?? "";
  const authorId = str(raw.author_id);
  const refs = Array.isArray(raw.referenced_tweets) ? raw.referenced_tweets.filter(isRecord) : [];

  const refOf = (type: string): ShapedRef | undefined => {
    const ref = refs.find((r) => str(r.type) === type);
    const refId = ref ? str(ref.id) : undefined;
    return refId ? shapeRef(refId, index) : undefined;
  };

  const reposts = refOf("retweeted");
  // A retweet's own `text` is a truncated "RT @someone: …". Show the original's
  // text instead, so the model reads content rather than an ellipsis.
  const text = reposts?.text ? reposts.text : fullText(raw);

  const metrics = shapeMetrics(raw);
  const media = shapeMedia(raw, index);
  const quotes = refOf("quoted");
  const repliesTo = refOf("replied_to");

  return {
    id,
    url: postUrl(authorId, id, index),
    author: formatAuthor(authorId, index),
    ...(str(raw.created_at) ? { created_at: str(raw.created_at) } : {}),
    text,
    ...(str(raw.lang) ? { lang: str(raw.lang) } : {}),
    ...(metrics ? { metrics } : {}),
    ...(quotes ? { quotes } : {}),
    ...(repliesTo ? { replies_to: repliesTo } : {}),
    ...(reposts ? { reposts } : {}),
    ...(media ? { media } : {}),
    ...(str(raw.conversation_id) ? { conversation_id: str(raw.conversation_id) } : {}),
  };
};

export type ShapedUser = {
  id: string;
  username: string;
  name?: string;
  url: string;
  description?: string;
  verified?: boolean;
  protected?: boolean;
  location?: string;
  created_at?: string;
  metrics?: { followers?: number; following?: number; posts?: number; listed?: number };
};

export const shapeUser = (raw: Rec): ShapedUser => {
  const username = str(raw.username) ?? "";
  const m = isRecord(raw.public_metrics) ? raw.public_metrics : undefined;
  const metrics = m
    ? {
        followers: num(m.followers_count),
        following: num(m.following_count),
        posts: num(m.tweet_count),
        listed: num(m.listed_count),
      }
    : undefined;
  const hasMetrics = metrics && Object.values(metrics).some((v) => v !== undefined);

  return {
    id: str(raw.id) ?? "",
    username,
    ...(str(raw.name) ? { name: str(raw.name) } : {}),
    url: `https://x.com/${username}`,
    ...(str(raw.description) ? { description: str(raw.description) } : {}),
    ...(typeof raw.verified === "boolean" ? { verified: raw.verified } : {}),
    ...(typeof raw.protected === "boolean" ? { protected: raw.protected } : {}),
    ...(str(raw.location) ? { location: str(raw.location) } : {}),
    ...(str(raw.created_at) ? { created_at: str(raw.created_at) } : {}),
    ...(hasMetrics ? { metrics } : {}),
  };
};

export type ShapedPosts = {
  posts: ShapedPost[];
  result_count?: number;
  next_token?: string;
  /** Ids X refused to return — deleted, protected, or suspended. */
  not_found?: string[];
};

/**
 * X reports per-id failures in a top-level `errors` array *alongside* a 200, so
 * asking for five posts and getting three back is a success with a footnote.
 * Surfacing the missing ids beats letting the model wonder where they went.
 */
const notFoundIds = (response: unknown): string[] | undefined => {
  if (!isRecord(response) || !Array.isArray(response.errors)) return undefined;
  const ids = response.errors
    .filter(isRecord)
    .map((e) => str(e.value) ?? str(e.resource_id))
    .filter((v): v is string => v !== undefined);
  return ids.length > 0 ? ids : undefined;
};

/** Flatten a list-of-posts response. Accepts a single- or multi-page envelope. */
export const shapePostsResponse = (response: unknown): ShapedPosts => {
  const index = buildIncludesIndex(includesOf(response));
  const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
  const meta = isRecord(response) && isRecord(response.meta) ? response.meta : undefined;
  const notFound = notFoundIds(response);

  return {
    posts: data.filter(isRecord).map((raw) => shapePost(raw, index)),
    ...(meta && num(meta.result_count) !== undefined
      ? { result_count: num(meta.result_count) }
      : {}),
    ...(meta && str(meta.next_token) ? { next_token: str(meta.next_token) } : {}),
    ...(notFound ? { not_found: notFound } : {}),
  };
};

/** Flatten a single-post response. */
export const shapePostResponse = (response: unknown): ShapedPost | { error: string } => {
  const index = buildIncludesIndex(includesOf(response));
  const data = isRecord(response) && isRecord(response.data) ? response.data : undefined;
  if (!data) {
    const notFound = notFoundIds(response);
    return {
      error: notFound
        ? `X returned no post for id ${notFound.join(", ")} — it is deleted, protected, or from a suspended account.`
        : "X returned no post for that id.",
    };
  }
  return shapePost(data, index);
};

export type ShapedUsers = { users: ShapedUser[]; not_found?: string[] };

export const shapeUsersResponse = (response: unknown): ShapedUsers => {
  const raw = isRecord(response) ? response.data : undefined;
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
  const notFound = notFoundIds(response);
  return {
    users: list.filter(isRecord).map(shapeUser),
    ...(notFound ? { not_found: notFound } : {}),
  };
};

/** What `XApiClient.paginate` hands back, as far as shaping is concerned. */
export type PostPage = {
  data: unknown[];
  /** One block per page — merged here, which is the whole point of this function. */
  includes: Rec[];
  nextToken?: string | undefined;
  /** Per-id failures X reports alongside a 200, collected across pages. */
  errors?: unknown[] | undefined;
};

/**
 * Assemble the shaped form from a paginated read, where includes arrive per
 * page. Every tool that paginates goes through here rather than through
 * `shapePostsResponse` with the first page's includes: a post on page two whose
 * author was only sideloaded on page two would otherwise come back as
 * "@unknown", which looks exactly like a deleted account and is not one.
 */
export const shapePaginatedPosts = (page: PostPage): ShapedPosts => {
  const index = buildIncludesIndex(page.includes);
  const notFound = notFoundIds({ errors: page.errors ?? [] });
  return {
    posts: page.data.filter(isRecord).map((raw) => shapePost(raw, index)),
    result_count: page.data.length,
    ...(page.nextToken ? { next_token: page.nextToken } : {}),
    ...(notFound ? { not_found: notFound } : {}),
  };
};
