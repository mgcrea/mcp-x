// A response cache that exists for a pricing reason, not just a latency one.
//
// X bills per resource read, but deduplicates within a 24-hour UTC window: if
// you read post 123 twice on the same UTC day, you pay once. Caching by
// (kind, id, utcDay) therefore mirrors X's own billing rule exactly — a hit is
// free because it *would* have been free anyway.

export type ResourceKind = "post" | "user" | "owned";

/**
 * What the cache is keyed by, which is wider than what X bills by. An Article
 * is billed as the post that carries it, but it is cached apart from that post:
 * a post shaped for x_get_post holds no body, and serving it to x_get_article
 * would return an Article with nothing in it.
 */
export type CacheKind = ResourceKind | "article";

export type CacheStats = {
  day: string;
  entries: number;
  hits: number;
  misses: number;
  hit_rate: number;
};

export type DayCache = {
  get(kind: CacheKind, id: string): unknown | undefined;
  set(kind: CacheKind, id: string, value: unknown): void;
  stats(): CacheStats;
};

/**
 * The dedup window is the UTC calendar day, not a rolling 24 hours — so the
 * whole cache turns over at once at UTC midnight rather than expiring entry by
 * entry. Comparing a stored day string is both cheaper and more faithful than
 * per-entry timestamps.
 */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

const keyOf = (kind: CacheKind, id: string): string => `${kind}:${id}`;

export const createDayCache = (opts: {
  maxEntries: number;
  enabled?: boolean;
  now?: () => number;
}): DayCache => {
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled ?? true;
  let day = utcDay(now());
  let hits = 0;
  let misses = 0;
  // Insertion-ordered `Map` doubles as the LRU: re-inserting on a hit moves an
  // entry to the back, so the oldest key is always the first one iterated.
  const entries = new Map<string, unknown>();

  const rollover = (): void => {
    const today = utcDay(now());
    if (today !== day) {
      entries.clear();
      day = today;
    }
  };

  return {
    get(kind, id) {
      if (!enabled) return undefined;
      rollover();
      const key = keyOf(kind, id);
      if (!entries.has(key)) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(kind, id, value) {
      if (!enabled || opts.maxEntries === 0) return;
      rollover();
      const key = keyOf(kind, id);
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > opts.maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    stats() {
      rollover();
      const total = hits + misses;
      return {
        day,
        entries: entries.size,
        hits,
        misses,
        hit_rate: total === 0 ? 0 : Math.round((hits / total) * 100) / 100,
      };
    },
  };
};
