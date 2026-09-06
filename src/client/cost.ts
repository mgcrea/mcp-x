import { utcDay, type CacheStats, type ResourceKind } from "#/client/cache";
import type { Pricing } from "#/config";

/**
 * Which resource ids we have already been billed for today.
 *
 * This is deliberately NOT the response cache. The cache stores payloads and is
 * LRU-bounded; this stores only ids and is unbounded. If they were one
 * structure, evicting a payload under memory pressure would make the estimator
 * re-count an id X already charged us for, and over-report spend. Ids are ~20
 * bytes, so keeping every one for a day costs kilobytes in practice.
 */
export type Ledger = {
  /** Split ids into the ones today's read actually bills for and the ones already paid. */
  record(kind: ResourceKind, ids: string[]): { billable: string[]; free: string[] };
  /** Estimate a read before issuing it, for the budget guard. */
  estimate(kind: ResourceKind, ids: string[]): number;
  /** Estimate by count, for reads whose result ids are unknown in advance (searches). */
  estimateCount(kind: ResourceKind, count: number): number;
  recordCreate(hasUrl: boolean): void;
  spentUsd(): number;
  report(cache: CacheStats): UsageReport;
};

export type CostNote = {
  billable_post_reads?: number;
  billable_user_reads?: number;
  owned_reads?: number;
  free_from_cache?: number;
  estimated_usd: number;
  note?: string;
};

export type UsageReport = {
  day: string;
  since_process_start: {
    billable_post_reads: number;
    billable_user_reads: number;
    owned_reads: number;
    free_from_dedup: number;
    posts_created: number;
    estimated_usd: number;
  };
  read_cap: { monthly_cap: number; reads_this_session: number; cap_used_pct: number };
  budget?: { limit_usd: number; remaining_usd: number };
  cache: CacheStats;
  pricing: Pricing;
  disclaimer: string;
};

const rate = (pricing: Pricing, kind: ResourceKind): number =>
  kind === "post" ? pricing.postRead : kind === "user" ? pricing.userRead : pricing.ownedRead;

const round = (n: number): number => Math.round(n * 1000) / 1000;

export const createLedger = (opts: {
  pricing: Pricing;
  budgetUsd?: number | undefined;
  now?: () => number;
}): Ledger => {
  const now = opts.now ?? Date.now;
  let day = utcDay(now());
  let paid = new Set<string>();
  const counts = { post: 0, user: 0, owned: 0, freeFromDedup: 0, created: 0 };
  let spent = 0;

  const rollover = (): void => {
    const today = utcDay(now());
    if (today !== day) {
      // Yesterday's ids stop being free at UTC midnight, exactly as X's
      // dedup window does. Counters are cumulative for the session and survive.
      paid = new Set();
      day = today;
    }
  };

  return {
    record(kind, ids) {
      rollover();
      const billable: string[] = [];
      const free: string[] = [];
      for (const id of ids) {
        const key = `${kind}:${id}`;
        if (paid.has(key)) {
          free.push(id);
          counts.freeFromDedup += 1;
          continue;
        }
        paid.add(key);
        billable.push(id);
        counts[kind] += 1;
        spent += rate(opts.pricing, kind);
      }
      return { billable, free };
    },
    estimate(kind, ids) {
      rollover();
      const unpaid = ids.filter((id) => !paid.has(`${kind}:${id}`));
      return unpaid.length * rate(opts.pricing, kind);
    },
    estimateCount(kind, count) {
      return count * rate(opts.pricing, kind);
    },
    recordCreate(hasUrl) {
      counts.created += 1;
      spent += hasUrl ? opts.pricing.postCreateWithUrl : opts.pricing.postCreate;
    },
    spentUsd: () => round(spent),
    report(cache) {
      rollover();
      const reads = counts.post + counts.user + counts.owned;
      return {
        day,
        since_process_start: {
          billable_post_reads: counts.post,
          billable_user_reads: counts.user,
          owned_reads: counts.owned,
          free_from_dedup: counts.freeFromDedup,
          posts_created: counts.created,
          estimated_usd: round(spent),
        },
        read_cap: {
          monthly_cap: opts.pricing.monthlyReadCap,
          reads_this_session: reads,
          cap_used_pct: Math.round((reads / opts.pricing.monthlyReadCap) * 10000) / 100,
        },
        ...(opts.budgetUsd !== undefined
          ? {
              budget: {
                limit_usd: opts.budgetUsd,
                remaining_usd: round(Math.max(0, opts.budgetUsd - spent)),
              },
            }
          : {}),
        cache,
        pricing: opts.pricing,
        disclaimer:
          "Estimated locally from X's published pay-per-use rates and counted only since this " +
          "process started — it is not persisted across restarts, and does not know about spend " +
          "from other clients. The X developer console (console.x.com) is the authoritative record.",
      };
    },
  };
};
