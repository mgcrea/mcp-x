import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AdsApiClient } from "#/client/ads";
import { isRecord } from "#/client/ads-shape";
import { accountIdArg, adsCostNote, adsCountArg, shapeAds } from "#/tools/ads/util";
import type { AdsContext } from "#/tools/index";
import { wrap } from "#/tools/util";

export const registerAdsAccountTools = (
  server: McpServer,
  client: AdsApiClient,
  ads: AdsContext,
  resolveAccount: (explicit?: string) => Promise<string>,
): void => {
  server.registerTool(
    "x_ads_get_accounts",
    {
      title: "X: Ads Get Accounts",
      description:
        "List the advertising accounts this login can reach, with their name, currency, timezone " +
        "and approval status. Start here: every other ads tool needs an account id, and the " +
        "currency and timezone returned here decide how budgets and analytics dates are read.",
      inputSchema: z.object({
        count: adsCountArg,
        withDeleted: z
          .boolean()
          .default(false)
          .describe("Include deleted accounts. Off by default."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ count, withDeleted }) =>
      wrap(async () => {
        const page = await client.paginateCursor(
          "/12/accounts",
          {
            count,
            ...(withDeleted ? { with_deleted: true } : {}),
          },
          { maxItems: count },
        );
        return {
          accounts: shapeAds({ data: page.data }),
          environment: ads.sandbox ? "sandbox" : "production",
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_get_funding_instruments",
    {
      title: "X: Ads Get Funding Instruments",
      description:
        "List an account's funding instruments — the payment sources campaigns draw from. A " +
        "campaign cannot be created without one, and the instrument's `currency` is the currency " +
        "every budget on that campaign is stated in. Check `able_to_fund` before using one.",
      inputSchema: z.object({ accountId: accountIdArg, count: adsCountArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, count }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const page = await client.paginateCursor(
          `/12/accounts/${id}/funding_instruments`,
          { count },
          { maxItems: count },
        );
        return {
          account_id: id,
          funding_instruments: shapeAds({ data: page.data }),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          cost: adsCostNote(),
        };
      }),
  );

  // Sandbox only: on production these entities are created by X, not by callers,
  // and offering the tool anywhere else would be offering a guaranteed failure.
  // It also creates something, so it sits behind the same write gate as every
  // other creating tool — a read-only sandbox profile gets no creating tools.
  if (!ads.sandbox || !ads.allowWrites) return;

  server.registerTool(
    "x_ads_create_sandbox_account",
    {
      title: "X: Ads Create Sandbox Account",
      description:
        "Create a throwaway ads account in the sandbox, complete with a funding instrument, so " +
        "the campaign tools can be exercised without spending anything. Sandbox only — this tool " +
        "is not registered against production, and needs X_ADS_ALLOW_WRITES like every other " +
        "creating tool.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async () =>
      wrap(async () => {
        const created = await client.post("/12/accounts");
        const data = isRecord(created) ? created.data : undefined;
        const id = isRecord(data) && typeof data.id === "string" ? data.id : undefined;
        return {
          account: data,
          ...(id
            ? {
                next_step:
                  `Pass accountId: "${id}" to the other ads tools, or set X_ADS_ACCOUNT_ID to it. ` +
                  `Call x_ads_get_funding_instruments to find the funding instrument id you will ` +
                  `need to create a campaign.`,
              }
            : {}),
          cost: adsCostNote(),
        };
      }),
  );
};
