import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "#/client/errors";
import type { XApiClient } from "#/client/x";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

const V2_PREFIX = "/2/";
const ADS_PREFIX = "/12/";

/** Reject traversal, protocol-relative URLs and anything outside the two API roots. */
export const assertSafePath = (path: string, adsAvailable: boolean): "v2" | "ads" => {
  if (path.includes("..")) throw new PreconditionError("Path may not contain `..`.", { path });
  if (path.startsWith("//")) {
    throw new PreconditionError("Path may not start with `//` — that is a protocol-relative URL.", {
      path,
    });
  }
  if (path.startsWith(V2_PREFIX)) return "v2";
  if (path.startsWith(ADS_PREFIX)) {
    if (!adsAvailable) {
      throw new PreconditionError(
        "Ads API paths need X_ADS_ENABLED=1 and an OAuth login; the Ads client is not configured.",
        { path },
      );
    }
    return "ads";
  }
  throw new PreconditionError(
    `Path must start with "${V2_PREFIX}" (X API v2) or "${ADS_PREFIX}" (Ads API), got ${JSON.stringify(path)}.`,
    { path },
  );
};

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The escape hatch: every API has more endpoints than anyone wraps, and
 * without this a missing one means a code change. Constrained so it cannot
 * become a way around the write gates — the method enum itself narrows to GET
 * when writes are off, the handler checks again, and a mutation needs the same
 * explicit `confirm` every other write tool takes.
 *
 * Nothing here goes through the cache or the ledger: the response is whatever
 * X sent, and the cost note says so rather than pretending to a number.
 */
export const registerRequestTool = (
  server: McpServer,
  client: XApiClient,
  ctx: ToolContext,
): void => {
  // A v2 write needs a user context on top of the flag; an ads write needs its
  // own flag. Either being on is enough to offer the non-GET methods, and the
  // handler sorts out which root a given path is under.
  const v2Writes = ctx.allowWrites && Boolean(ctx.login);
  const adsWrites = Boolean(ctx.ads?.allowWrites);
  const allowWrites = v2Writes || adsWrites;
  const methods = allowWrites ? (["GET", "POST", "PUT", "DELETE"] as const) : (["GET"] as const);

  server.registerTool(
    "x_request",
    {
      title: "X: Request",
      description:
        "Call any X API v2 or Ads API endpoint directly, for the endpoints this server does not " +
        "wrap. Paths are absolute: `/2/...` goes to api.x.com and `/12/...` to the Ads API " +
        "(when X_ADS_ENABLED). The response is returned raw and unshaped — no author joins, no " +
        "t.co expansion — so prefer a dedicated tool whenever one exists. Reads made here are " +
        "billed by X like any other but are NOT counted by this server's ledger, so " +
        "x_get_usage_report will under-report after using it. " +
        (allowWrites
          ? "Writes are ENABLED, so POST, PUT and DELETE are permitted; they need `confirm: true`. " +
            (v2Writes ? "" : "Only Ads (`/12/`) paths may be written — X_ALLOW_WRITES is off. ") +
            (adsWrites ? "" : "Only v2 (`/2/`) paths may be written — X_ADS_ALLOW_WRITES is off. ")
          : "Writes are DISABLED: only GET is permitted. Set X_ALLOW_WRITES=1 (with an OAuth " +
            "login) for v2 writes, or X_ADS_ALLOW_WRITES=1 for Ads writes."),
      inputSchema: z.object({
        method: z.enum(methods).default("GET").describe("HTTP method."),
        path: z
          .string()
          .min(1)
          .describe(
            'Absolute API path starting with "/2/" or "/12/", e.g. "/2/tweets/1799000000000000001" ' +
              'or "/12/accounts". No host, no query string.',
          ),
        query: z
          .record(z.string(), z.union([scalar, z.array(z.string())]))
          .optional()
          .describe(
            "Query parameters. Arrays are joined with commas, which is how X takes both field " +
              'lists and id batches, e.g. {"ids": ["1", "2"], "tweet.fields": ["created_at"]}.',
          ),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "JSON body for a v2 POST or PUT. The Ads API takes its parameters in `query` " +
              "instead, never a body.",
          ),
        auth: z
          .enum(["app", "user"])
          .default("app")
          .describe(
            "Which v2 credential to send: the app-only Bearer token, or the logged-in user's. " +
              "Anything under /2/users/me, bookmarks, timelines or any write needs `user`. Ads " +
              "paths always use the user token.",
          ),
        confirm: z
          .literal(true)
          .optional()
          .describe("Required for POST, PUT and DELETE: explicit acknowledgement of a mutation."),
      }),
      annotations: {
        readOnlyHint: !allowWrites,
        destructiveHint: allowWrites,
        openWorldHint: true,
      },
    },
    async ({ method, path, query, body, auth, confirm }) =>
      wrap(async () => {
        const root = assertSafePath(path, Boolean(ctx.ads));
        if (method !== "GET") {
          // Belt and braces: the enum already excludes these when writes are
          // off, but a client could hand-roll a request that skips validation.
          if (root === "v2" && !v2Writes) {
            throw new PreconditionError(
              `x_request ${method} on a v2 path needs X_ALLOW_WRITES=1 and an OAuth login.`,
              { method, path },
            );
          }
          if (root === "ads" && !adsWrites) {
            throw new PreconditionError(
              `x_request ${method} on an Ads path needs X_ADS_ALLOW_WRITES=1.`,
              { method, path },
            );
          }
          if (confirm !== true) {
            throw new PreconditionError(
              `x_request ${method} changes something on X; pass confirm: true to proceed.`,
              { method, path },
            );
          }
        }

        const started = Date.now();
        const response =
          root === "ads"
            ? await (ctx.ads as NonNullable<ToolContext["ads"]>).client.request(method, path, query)
            : await client.request(method, path, {
                ...(query ? { query } : {}),
                ...(body !== undefined ? { body } : {}),
                auth: method === "GET" ? auth : "user",
              });

        const source =
          root === "ads" ? (ctx.ads as NonNullable<ToolContext["ads"]>).client : client;
        const snapshot = source
          .rateLimitStatus()
          .filter((s) => s.endpoint.endsWith(path.replace(/\d{5,}/g, ":id").split("?")[0] ?? ""));
        return {
          method,
          path,
          response,
          elapsed_ms: Date.now() - started,
          ...(snapshot.length > 0 ? { rate_limit: snapshot } : {}),
          cost: {
            note:
              "Not tracked: reads through x_request are billed by X but do not reach this " +
              "server's ledger or dedup cache. Use a dedicated tool for anything it covers.",
          },
        };
      }),
  );
};
