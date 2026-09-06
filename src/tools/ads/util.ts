import { z } from "zod";

import type { AdsApiClient } from "#/client/ads";
import { adsData, isRecord, shapeMoney } from "#/client/ads-shape";
import { AdsAccessError, PreconditionError } from "#/client/errors";
import type { AdsContext } from "#/tools/index";

/**
 * Ads calls are not metered by X's pay-per-use rates, so they carry a fixed
 * note rather than a ledger entry. Saying it on every result is deliberate: the
 * absence of a cost line would otherwise read as "not measured", and the real
 * point is that the tool is free while the campaigns it manages are not.
 */
export const adsCostNote = (): { estimated_usd: number; note: string } => ({
  estimated_usd: 0,
  note:
    "Ads API calls are not billed under X's pay-per-use read pricing, so this costs nothing and " +
    "does not appear in x_get_usage_report. The campaigns it manages spend your advertising budget.",
});

export const accountIdArg = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9]+$/, 'An ads account id is letters and digits, e.g. "18ce54d4x5t".')
  .optional()
  .describe(
    'The ads account to act on, e.g. "18ce54d4x5t". Omit it when you have exactly one account ' +
      "or X_ADS_ACCOUNT_ID is set — it is resolved automatically. List them with x_ads_get_accounts.",
  );

export const entityIdArg = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9]+$/)
  .describe('An ads entity id, e.g. a campaign or line item id like "8v7jo".');

export const adsCountArg = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(200)
  .describe("How many records to return (1-1000). X's own default is 200.");

export const adsConfirmArg = z
  .literal(true)
  .describe(
    "Must be true. Explicit acknowledgement that this changes a live advertising campaign and " +
      "can spend your advertising budget.",
  );

export const activateArg = z
  .boolean()
  .default(false)
  .describe(
    "Create this ACTIVE instead of PAUSED. Defaults to false, which is the safe path: a PAUSED " +
      "entity spends nothing until you activate it with x_ads_set_entity_status. Set true only " +
      "when you intend spending to start the moment this call returns.",
  );

/**
 * Budgets are taken in major units and converted here, so a caller never sees a
 * `*_micro` field on the way in. A factor of a million is not a mistake anyone
 * catches by reading a number back, so the safest design is one where it cannot
 * be expressed.
 */
export const budgetArg = z
  .number()
  .positive()
  .max(10_000)
  .describe(
    "Budget in MAJOR units of the funding instrument's currency — 50 means 50.00, not 50 " +
      "million. Do NOT multiply by 1,000,000; this server converts to X's " +
      "*_amount_local_micro field for you. Capped at 10,000 per call.",
  );

/** ISO-8601, which the Ads API requires at whole-hour boundaries. */
export const adsTimeArg = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/,
    'X requires whole hours in ISO-8601 UTC, e.g. "2026-08-01T00:00:00Z".',
  )
  .describe('An ISO-8601 UTC time on a whole hour, e.g. "2026-08-01T00:00:00Z".');

/** Shape one ads entity or list for a tool result. */
export const shapeAds = (raw: unknown, currency?: string): unknown =>
  shapeMoney(adsData(raw) ?? raw, currency);

/**
 * Resolve which ads account a call is about.
 *
 * Mirrors `resolveOwnUserId` for timelines: prefer what the caller said, fall
 * back to configuration, and only then ask X — caching the answer so it happens
 * at most once per process. Unlike that case there is no token file to persist
 * into, so the memo lives in the closure and dies with the process, which is
 * fine for something that costs one request.
 *
 * The multi-account branch deliberately refuses rather than guessing. Agency
 * users hit it immediately, and silently picking the first account would create
 * campaigns in the wrong client's account — a mistake that spends real money
 * and is not obvious from the response.
 */
export const createAccountResolver = (
  client: AdsApiClient,
  ads: AdsContext,
): ((explicit?: string) => Promise<string>) => {
  let memo: string | undefined;

  return async (explicit?: string): Promise<string> => {
    if (explicit) return explicit;
    if (ads.accountId) return ads.accountId;
    if (memo) return memo;

    const raw = await client.get("/12/accounts", { count: 50 });
    const list = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];

    if (list.length === 0) {
      throw new AdsAccessError(
        "The logged-in account has access to no ads accounts, so there is nothing to act on. " +
          "Either this X user has not been granted a role on an ads account (that is done in " +
          "ads.x.com, not the developer console), or the app is not approved for the Ads API " +
          "yet. Check x_get_auth_status for the setup steps." +
          (ads.sandbox ? " In the sandbox, call x_ads_create_sandbox_account to make one." : ""),
        { baseUrl: ads.baseUrl, sandbox: ads.sandbox },
      );
    }

    if (list.length > 1) {
      const accounts = list.filter(isRecord).map((a) => ({ id: a.id, name: a.name }));
      throw new PreconditionError(
        `This login can reach ${list.length} ads accounts, so there is no safe default. Pass ` +
          `accountId explicitly, or set X_ADS_ACCOUNT_ID.`,
        { accounts },
      );
    }

    const only = list[0];
    const id = isRecord(only) && typeof only.id === "string" ? only.id : undefined;
    if (!id) {
      throw new AdsAccessError("X returned an ads account with no id, so it cannot be addressed.", {
        received: only,
      });
    }
    memo = id;
    return id;
  };
};
