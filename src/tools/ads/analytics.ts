import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AdsApiClient } from "#/client/ads";
import { isRecord, shapeMoney } from "#/client/ads-shape";
import { PreconditionError } from "#/client/errors";
import { accountIdArg, adsCostNote, adsTimeArg, entityIdArg } from "#/tools/ads/util";
import { compact, wrap } from "#/tools/util";

const ENTITIES = [
  "ACCOUNT",
  "CAMPAIGN",
  "FUNDING_INSTRUMENT",
  "LINE_ITEM",
  "PROMOTED_ACCOUNT",
  "PROMOTED_TWEET",
] as const;

const METRIC_GROUPS = [
  "ENGAGEMENT",
  "BILLING",
  "VIDEO",
  "MEDIA",
  "WEB_CONVERSION",
  "MOBILE_CONVERSION",
  "LIFE_TIME_VALUE_MOBILE_CONVERSION",
] as const;

/**
 * The synchronous endpoint accepts only these three. `PUBLISHER_NETWORK` is a
 * valid line-item placement but not a valid analytics placement, and passing it
 * here is rejected — worth pinning in the schema rather than discovering at
 * runtime.
 */
const PLACEMENTS = ["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"] as const;

const SEGMENTATIONS = ["AGE", "GENDER", "METROS", "PLATFORMS", "CONVERSION_TAGS"] as const;

const HOUR = 60 * 60 * 1000;
const SYNC_MAX_DAYS = 7;
const SYNC_MAX_ENTITIES = 20;

/** X answers job ids as JSON numbers too large for a JS number to hold exactly. */
const jobIdOf = (job: Record<string, unknown>): string | undefined => {
  if (typeof job.id_str === "string" && job.id_str) return job.id_str;
  if (typeof job.id === "string" && job.id) return job.id;
  return undefined;
};

export const registerAdsAnalyticsTools = (
  server: McpServer,
  client: AdsApiClient,
  resolveAccount: (explicit?: string) => Promise<string>,
): void => {
  server.registerTool(
    "x_ads_get_stats",
    {
      title: "X: Ads Get Stats",
      description:
        "Performance metrics for up to 20 entities over at most 7 days, returned immediately. " +
        'This is the fast path — use it for "how did this campaign do last week". For longer ' +
        "ranges, segmentation, or more than 20 entities, use the async job tools instead. Times " +
        "must be whole hours, and endTime is exclusive.",
      inputSchema: z.object({
        accountId: accountIdArg,
        entity: z.enum(ENTITIES).describe("What kind of thing the ids refer to."),
        entityIds: z
          .array(entityIdArg)
          .min(1)
          .max(SYNC_MAX_ENTITIES)
          .describe(`The entities to report on. X allows at most ${SYNC_MAX_ENTITIES} per call.`),
        startTime: adsTimeArg.describe("Start of the window, ISO-8601 UTC on a whole hour."),
        endTime: adsTimeArg.describe("End of the window, exclusive. At most 7 days after start."),
        granularity: z
          .enum(["DAY", "HOUR", "TOTAL"])
          .default("DAY")
          .describe(
            "How finely to bucket. DAY and TOTAL expect startTime at midnight in the ACCOUNT's " +
              "timezone, which is not necessarily UTC — check it with x_ads_get_accounts.",
          ),
        placement: z
          .enum(PLACEMENTS)
          .default("ALL_ON_TWITTER")
          .describe("One placement per call. PUBLISHER_NETWORK is not valid here."),
        metricGroups: z
          .array(z.enum(METRIC_GROUPS))
          .min(1)
          .default(["ENGAGEMENT"])
          .describe("Which metric families to return. BILLING carries spend."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({
      accountId,
      entity,
      entityIds,
      startTime,
      endTime,
      granularity,
      placement,
      metricGroups,
    }) =>
      wrap(async () => {
        // Checked locally so a too-wide window fails instantly with the fix,
        // rather than as an opaque INVALID_PARAMETER from X.
        const span = Date.parse(endTime) - Date.parse(startTime);
        if (span <= 0) {
          throw new PreconditionError("endTime must be after startTime.", { startTime, endTime });
        }
        if (span > SYNC_MAX_DAYS * 24 * HOUR) {
          throw new PreconditionError(
            `The synchronous stats endpoint covers at most ${SYNC_MAX_DAYS} days, and this asks ` +
              `for ${Math.round(span / (24 * HOUR))}. Narrow the window, or use ` +
              `x_ads_create_stats_job, which reaches 90 days.`,
            { startTime, endTime, maxDays: SYNC_MAX_DAYS },
          );
        }

        const id = await resolveAccount(accountId);
        const raw = await client.get(`/12/stats/accounts/${id}`, {
          entity,
          entity_ids: entityIds,
          start_time: startTime,
          end_time: endTime,
          granularity,
          placement,
          metric_groups: metricGroups,
        });
        return {
          account_id: id,
          entity,
          granularity,
          placement,
          start_time: startTime,
          end_time: endTime,
          // BILLING metrics arrive as `billed_charge_local_micro`; shaped so a
          // model reads 47.5, not 47,500,000, on the one tool that reports spend.
          stats: shapeMoney(isRecord(raw) ? raw.data : raw),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_create_stats_job",
    {
      title: "X: Ads Create Stats Job",
      description:
        "Queue an asynchronous analytics job, for what the synchronous endpoint cannot do: up to " +
        "90 days (45 when segmented), segmentation by age, gender, platform or metro, and more " +
        "than 20 entities. Returns a job id — poll it with x_ads_get_stats_jobs until its status " +
        "is SUCCESS, then fetch the numbers with x_ads_download_stats_job. Queuing a job spends " +
        "nothing and changes nothing.",
      inputSchema: z.object({
        accountId: accountIdArg,
        entity: z.enum(ENTITIES).describe("What kind of thing the ids refer to."),
        entityIds: z.array(entityIdArg).min(1).max(200).describe("The entities to report on."),
        startTime: adsTimeArg.describe("Start of the window, ISO-8601 UTC on a whole hour."),
        endTime: adsTimeArg.describe("End of the window, exclusive."),
        granularity: z.enum(["DAY", "HOUR", "TOTAL"]).default("DAY").describe("Bucket size."),
        placement: z.enum(PLACEMENTS).default("ALL_ON_TWITTER").describe("One placement per job."),
        metricGroups: z
          .array(z.enum(METRIC_GROUPS))
          .min(1)
          .default(["ENGAGEMENT"])
          .describe("Which metric families to return."),
        segmentation: z
          .enum(SEGMENTATIONS)
          .optional()
          .describe(
            "Break the numbers down by this dimension. Segmented jobs are capped at 45 days. " +
              "METROS additionally needs `country`.",
          ),
        country: z
          .string()
          .optional()
          .describe("Targeting-value id of a country. Required when segmentation is METROS."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) =>
      wrap(async () => {
        if (args.segmentation === "METROS" && !args.country) {
          throw new PreconditionError(
            "Segmenting by METROS needs a `country`. Find its id with " +
              "x_ads_search_targeting_options type=locations, locationType=COUNTRIES.",
          );
        }
        const id = await resolveAccount(args.accountId);
        const raw = await client.post(
          `/12/stats/jobs/accounts/${id}`,
          compact({
            entity: args.entity,
            entity_ids: args.entityIds,
            start_time: args.startTime,
            end_time: args.endTime,
            granularity: args.granularity,
            placement: args.placement,
            metric_groups: args.metricGroups,
            segmentation_type: args.segmentation,
            country: args.country,
          }),
        );
        const job = isRecord(raw) && isRecord(raw.data) ? raw.data : {};
        return {
          account_id: id,
          job,
          job_id: jobIdOf(job),
          next_step:
            "Poll x_ads_get_stats_jobs until this job's status is SUCCESS, then call " +
            "x_ads_download_stats_job with its url. Jobs typically take seconds to minutes.",
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_get_stats_jobs",
    {
      title: "X: Ads Get Stats Jobs",
      description:
        "List this account's analytics jobs and their status. A job is ready when its status is " +
        "SUCCESS, at which point it carries a `url` to pass to x_ads_download_stats_job. Those " +
        "URLs expire, so re-read the job rather than reusing an old one.",
      inputSchema: z.object({
        accountId: accountIdArg,
        jobIds: z
          .array(z.string().min(1))
          .max(200)
          .optional()
          .describe("Only these job ids. Omit to list recent jobs."),
        count: z.number().int().min(1).max(200).default(50).describe("How many jobs to return."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, jobIds, count }) =>
      wrap(async () => {
        const id = await resolveAccount(accountId);
        const raw = await client.get(
          `/12/stats/jobs/accounts/${id}`,
          compact({ count, ...(jobIds?.length ? { job_ids: jobIds } : {}) }),
        );
        const jobs = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
        const ready = jobs.filter(isRecord).filter((j) => j.status === "SUCCESS").length;
        return {
          account_id: id,
          jobs: shapeMoney(jobs),
          ready_count: ready,
          ...(jobs.length > 0 && ready === 0
            ? { note: "No job has finished yet. Poll again in a few seconds." }
            : {}),
          cost: adsCostNote(),
        };
      }),
  );

  server.registerTool(
    "x_ads_download_stats_job",
    {
      title: "X: Ads Download Stats Job",
      description:
        "Fetch and decompress a finished analytics job's results. By default it returns a " +
        "per-entity summary rather than every row, because a segmented 90-day job is far larger " +
        "than a useful answer. Set raw to true for the underlying rows, bounded by maxRows. If " +
        "the download is refused as too large, re-run the job over fewer entities, a shorter " +
        "range, or a coarser granularity.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The `url` from a SUCCESS job in x_ads_get_stats_jobs. These expire."),
        raw: z
          .boolean()
          .default(false)
          .describe("Return the underlying rows instead of the summary."),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(200)
          .describe("Cap on rows returned when raw is true."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ url, raw, maxRows }) =>
      wrap(async () => {
        const { text, bytes } = await client.downloadGzipped(url);
        const parsed: unknown = JSON.parse(text);
        const rows = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];

        if (raw) {
          return {
            rows: shapeMoney(rows.slice(0, maxRows)),
            row_count: rows.length,
            truncated: rows.length > maxRows,
            decompressed_bytes: bytes,
            cost: adsCostNote(),
          };
        }

        // Summarise rather than echo: the caller almost always wants totals per
        // entity, and returning tens of thousands of rows to get them is a
        // context bill with no matching benefit.
        const summary = rows.filter(isRecord).map((row) => {
          const series = Array.isArray(row.id_data) ? row.id_data : [];
          const totals: Record<string, number> = {};
          for (const segment of series) {
            if (!isRecord(segment) || !isRecord(segment.metrics)) continue;
            for (const [metric, values] of Object.entries(segment.metrics)) {
              if (!Array.isArray(values)) continue;
              const sum = values.reduce<number>(
                (acc, v) => acc + (typeof v === "number" ? v : 0),
                0,
              );
              totals[metric] = (totals[metric] ?? 0) + sum;
            }
          }
          // `totals` carries `billed_charge_local_micro` when BILLING was asked
          // for; pair it with `billed_charge` like every other money field.
          return { id: row.id, segments: series.length, totals: shapeMoney(totals) };
        });

        return {
          entities: summary,
          row_count: rows.length,
          decompressed_bytes: bytes,
          note:
            "Totals are summed across every bucket and segment in the job. Pass raw: true for " +
            "the per-bucket rows.",
          cost: adsCostNote(),
        };
      }),
  );
};
