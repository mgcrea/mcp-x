import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AdsApiClient } from "#/client/ads";
import { isRecord } from "#/client/ads-shape";
import {
  accountIdArg,
  adsConfirmArg,
  adsCostNote,
  adsCountArg,
  entityIdArg,
  shapeAds,
} from "#/tools/ads/util";
import type { AdsContext } from "#/tools/index";
import { compact, wrap } from "#/tools/util";

/**
 * The twelve targeting-option lookup endpoints that exist under
 * `/12/targeting_criteria/`. Deliberately a closed list: guessing a thirteenth
 * (`keywords` is the one people reach for) 404s, and keyword research lives at
 * `/12/insights/keywords/search` on a different path entirely.
 */
const OPTION_TYPES = [
  "app_store_categories",
  "conversations",
  "devices",
  "events",
  "interests",
  "languages",
  "locations",
  "network_operators",
  "platform_versions",
  "platforms",
  "tv_markets",
  "tv_shows",
] as const;

const LOCATION_TYPES = ["COUNTRIES", "REGIONS", "METROS", "CITIES", "POSTAL_CODES"] as const;

export const registerAdsTargetingTools = (
  server: McpServer,
  client: AdsApiClient,
  ads: AdsContext,
  resolveAccount: (explicit?: string) => Promise<string>,
): void => {
  server.registerTool(
    "x_ads_get_targeting_criteria",
    {
      title: "X: Ads Get Targeting Criteria",
      description:
        "Read the targeting attached to one or more line items — the interests, locations, " +
        "keywords, follower look-alikes and audiences that decide who sees the ads. Targeting " +
        "hangs off line items, never off campaigns.",
      inputSchema: z.object({
        accountId: accountIdArg,
        lineItemIds: z
          .array(entityIdArg)
          .min(1)
          .max(200)
          .describe("The line items whose targeting you want. At least one is required."),
        count: adsCountArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, lineItemIds, count }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const page = await client.paginateCursor(
          `/12/accounts/${id}/targeting_criteria`,
          { count, line_item_ids: lineItemIds },
          { maxItems: count },
        );
        return {
          account_id: id,
          targeting_criteria: shapeAds({ data: page.data }),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_search_targeting_options",
    {
      title: "X: Ads Search Targeting Options",
      description:
        "Look up the valid values for a targeting type before using one. X's targeting takes " +
        'opaque ids, not names — a location is something like "96683cc9126741d1", not "Paris" ' +
        "— so this is the step that turns an intention into a `targetingValue` you can pass to " +
        "x_ads_create_targeting_criterion. There is no keyword option here: keywords are free " +
        "text and need no lookup.",
      inputSchema: z.object({
        type: z
          .enum(OPTION_TYPES)
          .describe("Which targeting dimension to search. Each maps to one X lookup endpoint."),
        q: z
          .string()
          .min(1)
          .optional()
          .describe('Free-text filter, e.g. "Paris" for locations or "cycling" for interests.'),
        locationType: z
          .enum(LOCATION_TYPES)
          .optional()
          .describe("For type=locations only: which granularity of place to return."),
        locale: z
          .string()
          .min(2)
          .optional()
          .describe('For type=tv_shows, which requires it, e.g. "en-US".'),
        eventTypes: z
          .array(z.string().min(1))
          .optional()
          .describe("For type=events, which requires it."),
        countryCode: z
          .string()
          .length(2)
          .optional()
          .describe('Two-letter country filter where the endpoint supports one, e.g. "FR".'),
        count: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(50)
          .describe(
            "How many options to return (1-1000). Defaults to 50 rather than X's 200: a " +
              "`locations` lookup is a full object per place, and the model only needs the one " +
              "that matches `q`. Raise it when a filter is too broad to narrow.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ type, q, locationType, locale, eventTypes, countryCode, count }) =>
      wrap(async () => {
        const page = await client.paginateCursor(
          `/12/targeting_criteria/${type}`,
          compact({
            count,
            q,
            location_type: locationType,
            locale,
            event_types: eventTypes,
            country_code: countryCode,
          }),
          { maxItems: count },
        );
        return {
          type,
          // Option objects carry a null for every field their type does not
          // use; dropping those halves a locations page without losing a value.
          options: page.data.map((option) =>
            isRecord(option)
              ? Object.fromEntries(Object.entries(option).filter(([, v]) => v !== null))
              : option,
          ),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          note:
            "Pass an option's `targeting_value` (or `id`) as targetingValue to " +
            "x_ads_create_targeting_criterion.",
          cost: adsCostNote(),
        };
      }),
  );

  if (!ads.allowWrites) return;

  server.registerTool(
    "x_ads_create_targeting_criterion",
    {
      title: "X: Ads Create Targeting Criterion",
      description:
        "Add one targeting criterion to a line item. Look the value up first with " +
        "x_ads_search_targeting_options — X takes opaque ids for most types, and an invented one " +
        "is rejected. Criteria of different types intersect (AND) while criteria of the same type " +
        "union (OR), so adding two locations widens the audience while adding a location and an " +
        "interest narrows it. Broadening targeting on an active line item increases spending.",
      inputSchema: z.object({
        accountId: accountIdArg,
        lineItemId: entityIdArg.describe("The line item to target."),
        targetingType: z
          .string()
          .min(1)
          .describe(
            'The criterion type, e.g. "LOCATION", "INTEREST", "BROAD_KEYWORD", "FOLLOWERS_OF_USER", ' +
              '"CUSTOM_AUDIENCE", "PLATFORM", "LANGUAGE".',
          ),
        targetingValue: z
          .string()
          .min(1)
          .describe(
            "The value for that type — an id from x_ads_search_targeting_options, or free text " +
              "for keyword types.",
          ),
        operatorType: z
          .enum(["EQ", "NE", "GTE", "LT"])
          .default("EQ")
          .describe("How to compare. EQ is right for almost everything; NE excludes."),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ accountId, lineItemId, targetingType, targetingValue, operatorType }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const created = await client.post(`/12/accounts/${id}/targeting_criteria`, {
          line_item_id: lineItemId,
          targeting_type: targetingType,
          targeting_value: targetingValue,
          operator_type: operatorType,
        });
        return {
          account_id: id,
          line_item_id: lineItemId,
          targeting_criterion: shapeAds(created),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_delete_targeting_criterion",
    {
      title: "X: Ads Delete Targeting Criterion",
      description:
        "Remove one targeting criterion from a line item. Narrowing or widening targeting on an " +
        "active line item changes who sees the ads immediately. Removing the last criterion " +
        "leaves the line item targeting everyone, which usually spends faster, not slower.",
      inputSchema: z.object({
        accountId: accountIdArg,
        targetingCriterionId: entityIdArg.describe(
          "The criterion id from x_ads_get_targeting_criteria.",
        ),
        confirm: adsConfirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ accountId, targetingCriterionId }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const res = await client.del(
          `/12/accounts/${id}/targeting_criteria/${targetingCriterionId}`,
        );
        return {
          account_id: id,
          deleted: targetingCriterionId,
          targeting_criterion: shapeAds(res),
          cost: adsCostNote(),
        };
      }),
  );
};
