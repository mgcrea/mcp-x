import type { McpServer } from "@modelcontextprotocol/server";

import type { AdsApiClient } from "#/client/ads";
import type { TokenProvider } from "#/client/auth";
import type { DayCache } from "#/client/cache";
import type { Ledger } from "#/client/cost";
import type { TokenStore } from "#/client/tokens";
import type { XApiClient } from "#/client/x";
import type { Pricing } from "#/config";
import { registerAdsTools } from "#/tools/ads/index";
import { registerAuthTools } from "#/tools/auth";
import { registerComposeTools } from "#/tools/compose";
import { registerPostTools } from "#/tools/posts";
import { registerRequestTool } from "#/tools/request";
import { registerQueryBuilderTool, registerSearchTools } from "#/tools/search";
import { registerTimelineTools } from "#/tools/timelines";
import { registerUsageTools } from "#/tools/usage";
import { registerUserTools } from "#/tools/users";

/**
 * Everything the ads tools need, as one object rather than four independently
 * optional fields: "the client exists exactly when ads is configured" is then
 * an invariant the type enforces rather than one that can drift.
 */
export type AdsContext = {
  client: AdsApiClient;
  /** Register the campaign-mutating tools. Off by default — see X_ADS_ALLOW_WRITES. */
  allowWrites: boolean;
  /** Default ads account. Absent means "resolve it lazily from GET /12/accounts". */
  accountId?: string | undefined;
  /** True when pointed at the Ads sandbox, where nothing spends real money. */
  sandbox: boolean;
  baseUrl: string;
};

/**
 * Threaded through every tool rather than a bare `allowWrites` boolean: the
 * cache and ledger are needed by every read tool, so a boolean would have been
 * widened on the first commit anyway.
 */
export type ToolContext = {
  /** Register the paid write tools too. Off by default — see X_ALLOW_WRITES. */
  allowWrites: boolean;
  /** "intent" (free web-intent URLs, the default) or "api" (paid POST /2/tweets). */
  writeBackend: "intent" | "api";
  autoOpenBrowser: boolean;
  /** Register x_search_all. Off by default — full-archive search needs a paid tier. */
  enableFullArchive: boolean;
  defaultMaxResults: number;
  pricing: Pricing;
  budgetUsd?: number | undefined;
  cache: DayCache;
  ledger: Ledger;
  tokenProvider: TokenProvider;
  /**
   * False when neither a Bearer token nor an OAuth client id is configured. The
   * server still starts and still serves the free local tools; the ones that
   * would call the X API are simply not registered.
   */
  hasCredentials: boolean;
  /** Setup guidance surfaced by x_get_auth_status when nothing is configured. */
  setup?: string[] | undefined;
  /** Misconfigurations `loadConfig` switched off rather than died over. */
  warnings: string[];
  /**
   * The OAuth callback URL in force. Surfaced by x_get_auth_status because under
   * a supervisor the port is assigned per profile, and the user has to
   * register that exact URL with the X app before a login can succeed.
   */
  redirectUri: string;
  /** Where the OAuth tokens live, for x_get_auth_status. Absent when OAuth is unconfigured. */
  tokenFile?: string | undefined;
  /**
   * The token file, so a user id discovered lazily can be written back and not
   * re-fetched on every call. Absent when OAuth is unconfigured.
   */
  tokenStore?: TokenStore | undefined;
  /** Present only when a client id is configured; its presence registers the login tools. */
  login?: ((open: boolean) => Promise<LoginSummary>) | undefined;
  logout?: (() => void) | undefined;
  /** Present only when X_ADS_ENABLED is on and an OAuth client id is configured. */
  ads?: AdsContext | undefined;
  /** Ads setup guidance surfaced by x_get_auth_status when ads is not configured. */
  adsSetup?: string[] | undefined;
};

export type LoginSummary = {
  username?: string | undefined;
  userId?: string | undefined;
  scopes: string[];
  tokenFile: string;
};

/**
 * Register the X API tools.
 *
 * Read tools and the free compose tools are always registered. The paid write
 * tools appear only when `allowWrites` *and* `writeBackend === "api"`;
 * `x_search_all` only when full-archive access is enabled; and the login tools
 * and user-context timelines only when an OAuth client id is configured — so
 * with the defaults those tools are not merely refused, they are invisible and
 * cannot be called at all.
 */
export const registerTools = (server: McpServer, client: XApiClient, ctx: ToolContext): void => {
  // Always available: these run locally and need no credentials at all. They are
  // registered first and unconditionally so that an unconfigured server is still
  // a useful one, rather than a connection that closes.
  registerComposeTools(server, client, ctx);
  registerAuthTools(server, ctx);
  registerQueryBuilderTool(server);

  if (!ctx.hasCredentials) return;

  registerPostTools(server, client, ctx);
  registerUserTools(server, client, ctx);
  registerSearchTools(server, client, ctx);
  registerUsageTools(server, client, ctx);
  // Bookmarks and the home timeline are unreachable without a user session, so
  // registering them Bearer-only would just hand the model two tools that
  // always fail with the same message.
  if (ctx.login) {
    registerTimelineTools(server, client, ctx);
    // Same reasoning for ads, which is user-context only: an app-only Bearer
    // token cannot reach /12/accounts at all.
    if (ctx.ads) registerAdsTools(server, ctx.ads.client, ctx);
  }
  // Last, so its method enum can see every gate above: it widens past GET only
  // when a write gate is on, and it is never registered without credentials.
  registerRequestTool(server, client, ctx);
};
