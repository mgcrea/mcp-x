import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AdsApiClient } from "#/client/ads";
import { isRecord, toMicro } from "#/client/ads-shape";
import {
  accountIdArg,
  activateArg,
  adsConfirmArg,
  adsCostNote,
  adsCountArg,
  adsTimeArg,
  budgetArg,
  entityIdArg,
  shapeAds,
} from "#/tools/ads/util";
import type { AdsContext } from "#/tools/index";
import { compact, wrap } from "#/tools/util";

/**
 * Line-item enums, verbatim from the v12 reference and re-checked against
 * docs.x.com on 2026-09-06. Both lists are complete as published: there is no
 * `WEBSITE_CONVERSIONS` objective, and the asynchronous analytics
 * `segmentation_type` really is only the five values in `analytics.ts` — worth
 * recording, because both look like omissions and neither is one.
 */
const OBJECTIVES = [
  "APP_ENGAGEMENTS",
  "APP_INSTALLS",
  "REACH",
  "FOLLOWERS",
  "ENGAGEMENTS",
  "VIDEO_VIEWS",
  "PREROLL_VIEWS",
  "WEBSITE_CLICKS",
] as const;

const PRODUCT_TYPES = ["MEDIA", "PROMOTED_ACCOUNT", "PROMOTED_TWEETS"] as const;

const PLACEMENTS = [
  "ALL_ON_TWITTER",
  "PUBLISHER_NETWORK",
  "TAP_BANNER",
  "TAP_FULL",
  "TAP_FULL_LANDSCAPE",
  "TAP_NATIVE",
  "TAP_MRECT",
  "TWITTER_PROFILE",
  "TWITTER_REPLIES",
  "TWITTER_SEARCH",
  "TWITTER_TIMELINE",
] as const;

const ENTITY_KINDS = ["campaign", "line_item", "promoted_tweet"] as const;

const PATH_FOR: Record<(typeof ENTITY_KINDS)[number], string> = {
  campaign: "campaigns",
  line_item: "line_items",
  promoted_tweet: "promoted_tweets",
};

/**
 * What a create tool sends for `entity_status`, and the sentence explaining it.
 * PAUSED is the default because an ACTIVE campaign begins spending the moment
 * it exists, and an agent that mis-set a budget should not discover that from
 * the invoice. `activateImmediately` is the deliberate way out.
 */
const statusFor = (activate: boolean): { status: "ACTIVE" | "PAUSED"; note: string } =>
  activate
    ? {
        status: "ACTIVE",
        note: "Created ACTIVE, as requested — delivery and spending start now.",
      }
    : {
        status: "PAUSED",
        note:
          "Created PAUSED, so it is spending nothing. Activate it with x_ads_set_entity_status " +
          "when you are ready.",
      };

export const registerAdsCampaignTools = (
  server: McpServer,
  client: AdsApiClient,
  ads: AdsContext,
  resolveAccount: (explicit?: string) => Promise<string>,
): void => {
  /** The currency every budget on a campaign is denominated in. */
  const currencyOf = async (
    accountId: string,
    fundingInstrumentId: string,
  ): Promise<string | undefined> => {
    try {
      const raw = await client.get(
        `/12/accounts/${accountId}/funding_instruments/${fundingInstrumentId}`,
      );
      const data = isRecord(raw) ? raw.data : undefined;
      return isRecord(data) && typeof data.currency === "string" ? data.currency : undefined;
    } catch {
      // Never fail a write because the currency lookup did — the echo is a
      // courtesy, and a missing one is much cheaper than a lost campaign.
      return undefined;
    }
  };

  server.registerTool(
    "x_ads_get_campaigns",
    {
      title: "X: Ads Get Campaigns",
      description:
        "List an account's campaigns with their budgets, funding instrument and status. Budgets " +
        "come back in both major units (`daily_budget`) and X's raw millionths " +
        "(`daily_budget_amount_local_micro`) — read the former. Note that in v12 campaigns carry " +
        "no start or end date; flight dates live on their line items.",
      inputSchema: z.object({
        accountId: accountIdArg,
        campaignIds: z
          .array(entityIdArg)
          .max(200)
          .optional()
          .describe("Only these campaign ids. Omit to list them all."),
        count: adsCountArg,
        withDeleted: z.boolean().default(false).describe("Include deleted campaigns."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, campaignIds, count, withDeleted }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const page = await client.paginateCursor(
          `/12/accounts/${id}/campaigns`,
          compact({
            count,
            ...(campaignIds?.length ? { campaign_ids: campaignIds } : {}),
            ...(withDeleted ? { with_deleted: true } : {}),
          }),
          { maxItems: count },
        );
        return {
          account_id: id,
          campaigns: shapeAds({ data: page.data }),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_get_line_items",
    {
      title: "X: Ads Get Line Items",
      description:
        "List an account's line items — the ad groups that carry the objective, bid, placements " +
        "and flight dates under a campaign. Targeting and creatives attach to a line item, not " +
        "to its campaign, so this is the id you need for x_ads_get_targeting_criteria and " +
        "x_ads_create_promoted_tweet.",
      inputSchema: z.object({
        accountId: accountIdArg,
        campaignIds: z
          .array(entityIdArg)
          .max(200)
          .optional()
          .describe("Only line items under these campaigns."),
        lineItemIds: z.array(entityIdArg).max(200).optional().describe("Only these line item ids."),
        count: adsCountArg,
        withDeleted: z.boolean().default(false).describe("Include deleted line items."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, campaignIds, lineItemIds, count, withDeleted }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const page = await client.paginateCursor(
          `/12/accounts/${id}/line_items`,
          compact({
            count,
            ...(campaignIds?.length ? { campaign_ids: campaignIds } : {}),
            ...(lineItemIds?.length ? { line_item_ids: lineItemIds } : {}),
            ...(withDeleted ? { with_deleted: true } : {}),
          }),
          { maxItems: count },
        );
        return {
          account_id: id,
          line_items: shapeAds({ data: page.data }),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_get_promoted_tweets",
    {
      title: "X: Ads Get Promoted Tweets",
      description:
        "List the posts promoted under an account's line items. Each entry pairs a line item with " +
        "the post id it is promoting; look the post itself up with x_get_post if you need its text.",
      inputSchema: z.object({
        accountId: accountIdArg,
        lineItemIds: z
          .array(entityIdArg)
          .max(200)
          .optional()
          .describe("Only promoted posts under these line items."),
        count: adsCountArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, lineItemIds, count }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const page = await client.paginateCursor(
          `/12/accounts/${id}/promoted_tweets`,
          compact({ count, ...(lineItemIds?.length ? { line_item_ids: lineItemIds } : {}) }),
          { maxItems: count },
        );
        return {
          account_id: id,
          promoted_tweets: shapeAds({ data: page.data }),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          cost: adsCostNote(),
        };
      }),
  );

  // Everything below changes live advertising objects. Registered only when
  // X_ADS_ALLOW_WRITES is on, so with the defaults these tools do not exist.
  if (!ads.allowWrites) return;

  server.registerTool(
    "x_ads_create_campaign",
    {
      title: "X: Ads Create Campaign",
      description:
        "Create a campaign. SPENDS MONEY once activated. Budgets are given in MAJOR currency " +
        "units — 50 means 50.00 — and converted to X's millionths for you; never pass a " +
        "pre-multiplied figure. The campaign is created PAUSED unless you set " +
        "activateImmediately, so the normal flow is: create, add a line item, add targeting, then " +
        "activate. In v12 a campaign has no dates of its own; set them on the line item.",
      inputSchema: z.object({
        accountId: accountIdArg,
        fundingInstrumentId: entityIdArg.describe(
          "Which funding instrument pays for this. List them with x_ads_get_funding_instruments.",
        ),
        name: z.string().min(1).max(255).describe("Campaign name, up to 255 characters."),
        dailyBudget: budgetArg.describe(
          "Daily budget in MAJOR currency units of the funding instrument (50 means 50.00). Do " +
            "NOT multiply by 1,000,000.",
        ),
        totalBudget: budgetArg
          .optional()
          .describe("Optional lifetime cap, in the same major units as dailyBudget."),
        activateImmediately: activateArg,
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({
      accountId,
      fundingInstrumentId,
      name,
      dailyBudget,
      totalBudget,
      activateImmediately,
    }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const { status, note } = statusFor(activateImmediately);
        const dailyMicro = toMicro(dailyBudget);
        const totalMicro = totalBudget === undefined ? undefined : toMicro(totalBudget);

        const created = await client.post(
          `/12/accounts/${id}/campaigns`,
          compact({
            funding_instrument_id: fundingInstrumentId,
            name,
            daily_budget_amount_local_micro: dailyMicro,
            total_budget_amount_local_micro: totalMicro,
            entity_status: status,
          }),
        );

        const currency = await currencyOf(id, fundingInstrumentId);
        return {
          account_id: id,
          campaign: shapeAds(created, currency),
          entity_status: status,
          // Echo the arithmetic rather than only the result: a budget is the
          // one field where being off by a factor of a million is both easy
          // and expensive, and this makes it checkable at a glance.
          budget_sent: {
            daily_budget: dailyBudget,
            daily_budget_amount_local_micro: dailyMicro,
            ...(totalBudget !== undefined
              ? { total_budget: totalBudget, total_budget_amount_local_micro: totalMicro }
              : {}),
            ...(currency ? { currency } : {}),
          },
          next_step: note,
          environment: ads.sandbox ? "sandbox" : "production",
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_update_campaign",
    {
      title: "X: Ads Update Campaign",
      description:
        "Change a campaign's name, budget or status. Budgets are in MAJOR currency units, as on " +
        "create. Raising a daily budget on an ACTIVE campaign increases spending immediately.",
      inputSchema: z.object({
        accountId: accountIdArg,
        campaignId: entityIdArg.describe("The campaign to change."),
        name: z.string().min(1).max(255).optional().describe("New name."),
        dailyBudget: budgetArg.optional().describe("New daily budget, in major currency units."),
        totalBudget: budgetArg.optional().describe("New lifetime cap, in major currency units."),
        entityStatus: z
          .enum(["ACTIVE", "PAUSED"])
          .optional()
          .describe("ACTIVE resumes delivery and spending; PAUSED stops it."),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountId, campaignId, name, dailyBudget, totalBudget, entityStatus }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const dailyMicro = dailyBudget === undefined ? undefined : toMicro(dailyBudget);
        const totalMicro = totalBudget === undefined ? undefined : toMicro(totalBudget);
        const updated = await client.put(
          `/12/accounts/${id}/campaigns/${campaignId}`,
          compact({
            name,
            daily_budget_amount_local_micro: dailyMicro,
            total_budget_amount_local_micro: totalMicro,
            entity_status: entityStatus,
          }),
        );
        return {
          account_id: id,
          campaign: shapeAds(updated),
          ...(dailyBudget !== undefined
            ? {
                budget_sent: {
                  daily_budget: dailyBudget,
                  daily_budget_amount_local_micro: dailyMicro,
                },
              }
            : {}),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_delete_campaign",
    {
      title: "X: Ads Delete Campaign",
      description:
        "Delete a campaign. This also stops its line items. X keeps deleted campaigns visible to " +
        "`withDeleted` reads but they cannot be revived — pause the campaign instead if you may " +
        "want it back.",
      inputSchema: z.object({
        accountId: accountIdArg,
        campaignId: entityIdArg.describe("The campaign to delete."),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ accountId, campaignId }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const res = await client.del(`/12/accounts/${id}/campaigns/${campaignId}`);
        return {
          account_id: id,
          deleted: campaignId,
          campaign: shapeAds(res),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_create_line_item",
    {
      title: "X: Ads Create Line Item",
      description:
        "Create a line item under a campaign — the ad group carrying the objective, bid, " +
        "placements and flight dates. Created PAUSED unless activateImmediately is set. Bids are " +
        "in MAJOR currency units. A line item with no targeting criteria and no promoted post " +
        "will not deliver, so this is usually the second of three calls.",
      inputSchema: z.object({
        accountId: accountIdArg,
        campaignId: entityIdArg.describe("The campaign this belongs to."),
        name: z.string().min(1).max(255).optional().describe("Line item name."),
        objective: z.enum(OBJECTIVES).describe("What the line item optimises for."),
        productType: z.enum(PRODUCT_TYPES).describe("The kind of ad. Usually PROMOTED_TWEETS."),
        placements: z
          .array(z.enum(PLACEMENTS))
          .min(1)
          .describe("Where ads may appear. ALL_ON_TWITTER is the usual choice."),
        startTime: adsTimeArg
          .optional()
          .describe(
            "When delivery starts, ISO-8601 UTC on a whole hour. Omit to start now, which is " +
              "what X defaults to — a PAUSED line item does not deliver either way.",
          ),
        endTime: adsTimeArg.optional().describe("When delivery stops. Omit to run open-ended."),
        bid: budgetArg
          .optional()
          .describe("Bid in MAJOR currency units. Omit to let X bid automatically."),
        totalBudget: budgetArg.optional().describe("Lifetime cap for this line item."),
        activateImmediately: activateArg,
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) =>
      wrap(async () => {
        const id = await resolveAccount(args.accountId);
        const { status, note } = statusFor(args.activateImmediately);
        const bidMicro = args.bid === undefined ? undefined : toMicro(args.bid);
        const created = await client.post(
          `/12/accounts/${id}/line_items`,
          compact({
            campaign_id: args.campaignId,
            name: args.name,
            objective: args.objective,
            product_type: args.productType,
            placements: args.placements,
            start_time: args.startTime,
            end_time: args.endTime,
            bid_amount_local_micro: bidMicro,
            total_budget_amount_local_micro:
              args.totalBudget === undefined ? undefined : toMicro(args.totalBudget),
            entity_status: status,
          }),
        );
        return {
          account_id: id,
          line_item: shapeAds(created),
          entity_status: status,
          ...(args.bid !== undefined
            ? { bid_sent: { bid: args.bid, bid_amount_local_micro: bidMicro } }
            : {}),
          next_step:
            `${note} Attach targeting with x_ads_create_targeting_criterion and a post with ` +
            `x_ads_create_promoted_tweet before activating, or it will not deliver.`,
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_update_line_item",
    {
      title: "X: Ads Update Line Item",
      description:
        "Change a line item's name, bid, dates or status. Bids and budgets are in MAJOR currency " +
        "units, as on create.",
      inputSchema: z.object({
        accountId: accountIdArg,
        lineItemId: entityIdArg.describe("The line item to change."),
        name: z.string().min(1).max(255).optional().describe("New name."),
        bid: budgetArg.optional().describe("New bid, in major currency units."),
        totalBudget: budgetArg.optional().describe("New lifetime cap, in major currency units."),
        startTime: adsTimeArg.optional().describe("New start time."),
        endTime: adsTimeArg.optional().describe("New end time."),
        entityStatus: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Resume or stop delivery."),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      wrap(async () => {
        const id = await resolveAccount(args.accountId);
        const updated = await client.put(
          `/12/accounts/${id}/line_items/${args.lineItemId}`,
          compact({
            name: args.name,
            bid_amount_local_micro: args.bid === undefined ? undefined : toMicro(args.bid),
            total_budget_amount_local_micro:
              args.totalBudget === undefined ? undefined : toMicro(args.totalBudget),
            start_time: args.startTime,
            end_time: args.endTime,
            entity_status: args.entityStatus,
          }),
        );
        return { account_id: id, line_item: shapeAds(updated), cost: adsCostNote() };
      }),
  );

  server.registerTool(
    "x_ads_delete_line_item",
    {
      title: "X: Ads Delete Line Item",
      description:
        "Delete a line item. Irreversible — pause it instead if you may want it back. Its " +
        "targeting criteria and promoted posts stop delivering with it.",
      inputSchema: z.object({
        accountId: accountIdArg,
        lineItemId: entityIdArg.describe("The line item to delete."),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ accountId, lineItemId }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const res = await client.del(`/12/accounts/${id}/line_items/${lineItemId}`);
        return {
          account_id: id,
          deleted: lineItemId,
          line_item: shapeAds(res),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_create_promoted_tweet",
    {
      title: "X: Ads Create Promoted Tweet",
      description:
        "Promote existing posts under a line item. The posts must already exist — compose one " +
        "first with x_compose_post, or pick an id from x_get_user_posts. Promotion begins when " +
        "the line item is active.",
      inputSchema: z.object({
        accountId: accountIdArg,
        lineItemId: entityIdArg.describe("The line item that will carry these posts."),
        postIds: z
          .array(z.string().regex(/^\d+$/))
          .min(1)
          .max(50)
          .describe('Post ids to promote, e.g. ["1799000000000000001"].'),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ accountId, lineItemId, postIds }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const created = await client.post(`/12/accounts/${id}/promoted_tweets`, {
          line_item_id: lineItemId,
          tweet_ids: postIds,
        });
        return {
          account_id: id,
          line_item_id: lineItemId,
          promoted_tweets: shapeAds(created),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_delete_promoted_tweet",
    {
      title: "X: Ads Delete Promoted Tweet",
      description:
        "Stop promoting a post by removing it from its line item. The post itself is untouched " +
        "and stays on the timeline — use x_delete_post to remove that.",
      inputSchema: z.object({
        accountId: accountIdArg,
        promotedTweetId: entityIdArg.describe(
          "The promoted-tweet id from x_ads_get_promoted_tweets, not the post id.",
        ),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ accountId, promotedTweetId }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const res = await client.del(`/12/accounts/${id}/promoted_tweets/${promotedTweetId}`);
        return {
          account_id: id,
          deleted: promotedTweetId,
          promoted_tweet: shapeAds(res),
          note: "The post itself is unaffected and is still on the timeline.",
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_set_entity_status",
    {
      title: "X: Ads Set Entity Status",
      description:
        "Activate or pause a campaign or line item. This is the switch that starts and stops " +
        "spending: ACTIVE begins delivery immediately at the entity's configured budget. Check " +
        "the budget with x_ads_get_campaigns before activating something you did not just create.",
      inputSchema: z.object({
        accountId: accountIdArg,
        entityType: z
          .enum(["campaign", "line_item"])
          .describe("Which kind of entity the id refers to."),
        entityId: entityIdArg.describe("The campaign or line item id."),
        status: z
          .enum(["ACTIVE", "PAUSED"])
          .describe("ACTIVE starts delivery and spending. PAUSED stops it."),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountId, entityType, entityId, status }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const updated = await client.put(`/12/accounts/${id}/${PATH_FOR[entityType]}/${entityId}`, {
          entity_status: status,
        });
        return {
          account_id: id,
          entity_type: entityType,
          entity_id: entityId,
          entity_status: status,
          entity: shapeAds(updated),
          note:
            status === "ACTIVE"
              ? `Now ACTIVE${ads.sandbox ? " (sandbox — nothing is really spent)" : " — delivery and spending have started"}.`
              : "Now PAUSED. It is spending nothing.",
          cost: adsCostNote(),
        };
      }),
  );
};
