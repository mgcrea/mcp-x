export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** X states every money field in millionths of a currency unit. */
export const MICRO = 1_000_000;

export const toMicro = (major: number): number => Math.round(major * MICRO);
export const fromMicro = (micro: number): number => Math.round((micro / MICRO) * 100) / 100;

/**
 * Every money field X returns ends in `_local_micro`. Most are
 * `*_amount_local_micro` (budgets, bids), but funding instruments carry
 * `credit_limit_local_micro` / `credit_remaining_local_micro` and the BILLING
 * metric group carries `billed_charge_local_micro` — matching only the longer
 * suffix left exactly the fields that report real spend unconverted.
 */
const MICRO_SUFFIX = "_local_micro";
const AMOUNT_SUFFIX = "_amount_local_micro";

/**
 * Pair every `*_local_micro` field with the value a human would say.
 *
 * This is not cosmetic. A model that reads `daily_budget_amount_local_micro:
 * 50000000` and reasons about it concludes the budget is fifty million, and the
 * next thing it proposes is scaled by a factor of a million. The write path
 * guards against the same mistake by refusing micro inputs; this is the other
 * half, and without it the guard only covers one direction.
 *
 * The micro field is kept rather than replaced, so the raw value X returned
 * stays auditable. `daily_budget_amount_local_micro` pairs with `daily_budget`,
 * `credit_limit_local_micro` with `credit_limit`.
 */
export const shapeMoney = <T>(value: T, currency?: string): T => {
  if (Array.isArray(value)) return value.map((item) => shapeMoney(item, currency)) as T;
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = shapeMoney(raw, currency);
    if (!key.endsWith(MICRO_SUFFIX)) continue;
    // Entity fields hold one number; analytics metrics hold one number per time
    // bucket, so `billed_charge_local_micro` arrives as an array. Converting
    // only the scalar case left every spend series in millionths — on the one
    // endpoint whose whole purpose is reporting spend.
    const converted =
      typeof raw === "number"
        ? fromMicro(raw)
        : Array.isArray(raw) && raw.every((v) => typeof v === "number" || v === null)
          ? raw.map((v) => (typeof v === "number" ? fromMicro(v) : v))
          : undefined;
    if (converted === undefined) continue;
    const base = key.endsWith(AMOUNT_SUFFIX)
      ? key.slice(0, -AMOUNT_SUFFIX.length)
      : key.slice(0, -MICRO_SUFFIX.length);
    out[base] = converted;
    if (currency) out[`${base}_currency`] = currency;
  }
  return out as T;
};

/**
 * Strip the Ads API's envelope down to what a caller wants.
 *
 * Every ads response echoes the request back under `request`, which is pure
 * noise in a tool result — the caller just sent it. `next_cursor` and
 * `total_count` are lifted out by the client's pagination instead.
 */
export const adsData = (raw: unknown): unknown => (isRecord(raw) ? raw.data : undefined);
