import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

export const registerUsageTools = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "x_get_usage_report",
    {
      title: "X: Get Usage Report",
      description:
        "What this session has spent against X's pay-per-use rates, how much the dedup cache " +
        "saved, and the pricing table used to compute it. Estimates only, counted since this " +
        "process started — the X developer console (console.x.com) is the authoritative record.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ctx.ledger.report(ctx.cache.stats())),
  );

  server.registerTool(
    "x_get_rate_limit_status",
    {
      title: "X: Get Rate Limit Status",
      description:
        "Rate-limit headroom per endpoint, as of the last response from each. Empty until at " +
        "least one request has been made. Useful when a call has just been rate-limited and you " +
        "need to know how long to wait. Covers both the X API v2 and the Ads API, which have " +
        "separate budgets — the `api` field says which, and `scope` distinguishes the Ads " +
        "endpoint, account and cost limits.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        // Two clients, two independent budgets. Reading only the v2 one would
        // hide the account-level ads limit, which is the one that bites first
        // during a bulk campaign read.
        const limits = [
          ...client.rateLimitStatus().map((s) => ({ api: "v2" as const, ...s })),
          ...(ctx.ads
            ? ctx.ads.client.rateLimitStatus().map((s) => ({ api: "ads" as const, ...s }))
            : []),
        ];
        const adsSeen = limits.some((l) => l.api === "ads");
        return {
          endpoints: limits,
          ...(limits.length === 0
            ? { note: "No requests issued yet this session, so X has not reported any limits." }
            : {}),
          ...(ctx.ads && !adsSeen
            ? {
                ads_note:
                  "Ads is configured but has not been called yet this session, so it reports no " +
                  "limits. That is not a failure.",
              }
            : {}),
        };
      }),
  );
};
