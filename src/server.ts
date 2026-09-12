import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { AdsApiClient } from "#/client/ads";
import {
  bearerTokenProvider,
  compositeTokenProvider,
  userTokenProvider,
  type Logger,
  type TokenProvider,
} from "#/client/auth";
import { createDayCache, type DayCache } from "#/client/cache";
import { createLedger, type Ledger } from "#/client/cost";
import { createOAuthClient, startLoginFlow } from "#/client/oauth";
import { createTokenStore, type TokenStore } from "#/client/tokens";
import { XApiClient } from "#/client/x";
import { openInBrowser } from "#/compose/open";
import {
  adsSetupInstructions,
  hasAdsAccess,
  hasApiCredentials,
  requiredScopes,
  setupInstructions,
  type Config,
} from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-x-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests, and the OAuth user flow). */
  tokenProvider?: TokenProvider;
  now?: () => number;
};

export type CreatedServer = {
  server: McpServer;
  client: XApiClient;
  /** Present only when ads is configured. Exposed for tests and diagnostics. */
  ads?: AdsApiClient | undefined;
  tokenProvider: TokenProvider;
  cache: DayCache;
  ledger: Ledger;
  store: TokenStore;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // What a stored token must hold, which is less than what a login asks for:
  // see OPTIONAL_SCOPES.
  const scopes = requiredScopes(config);
  const store = createTokenStore(config.tokenFile, opts.logger);

  const tokenProvider =
    opts.tokenProvider ??
    compositeTokenProvider({
      ...(config.bearerToken ? { app: bearerTokenProvider(config.bearerToken) } : {}),
      ...(config.clientId
        ? {
            user: userTokenProvider({
              store,
              oauth: createOAuthClient(config, opts.fetch ?? fetch),
              clientId: config.clientId,
              requiredScopes: scopes,
              ...(opts.logger ? { logger: opts.logger } : {}),
              ...(opts.now ? { now: opts.now } : {}),
            }),
          }
        : {}),
    });

  const client = new XApiClient({
    baseUrl: config.baseUrl,
    tokenProvider,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  // Shares the token provider with the v2 client: ads rides the same OAuth 2.0
  // session, distinguished only by the ads.read / ads.write scopes.
  const ads = hasAdsAccess(config)
    ? new AdsApiClient({
        baseUrl: config.adsBaseUrl,
        tokenProvider,
        maxRetries: config.maxRetries,
        maxDownloadBytes: config.adsMaxDownloadBytes,
        userAgent: USER_AGENT,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
      })
    : undefined;

  const cache = createDayCache({
    maxEntries: config.cacheMaxEntries,
    enabled: config.cacheEnabled,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const ledger = createLedger({
    pricing: config.pricing,
    budgetUsd: config.monthlyBudgetUsd,
    ...(opts.now ? { now: opts.now } : {}),
  });

  registerTools(server, client, {
    allowWrites: config.allowWrites,
    writeBackend: config.writeBackend,
    autoOpenBrowser: config.autoOpenBrowser,
    enableFullArchive: config.enableFullArchive,
    defaultMaxResults: config.defaultMaxResults,
    pricing: config.pricing,
    budgetUsd: config.monthlyBudgetUsd,
    cache,
    ledger,
    tokenProvider,
    hasCredentials: hasApiCredentials(config),
    warnings: config.warnings,
    redirectUri: config.redirectUri,
    ...(hasApiCredentials(config) ? {} : { setup: setupInstructions(config) }),
    ...(ads
      ? {
          ads: {
            client: ads,
            allowWrites: config.adsAllowWrites,
            sandbox: ads.sandbox,
            baseUrl: config.adsBaseUrl,
            ...(config.adsAccountId ? { accountId: config.adsAccountId } : {}),
          },
        }
      : { adsSetup: adsSetupInstructions(config) }),
    ...(config.clientId
      ? {
          tokenFile: config.tokenFile,
          tokenStore: store,
          login: async (open: boolean) => {
            const { tokens } = await startLoginFlow({
              config,
              store,
              ...(opts.fetch ? { fetch: opts.fetch } : {}),
              ...(open ? { openBrowser: openInBrowser } : {}),
              ...(opts.logger ? { logger: opts.logger } : {}),
              ...(opts.now ? { now: opts.now } : {}),
            });
            return {
              username: tokens.username,
              userId: tokens.userId,
              scopes: tokens.scopes,
              tokenFile: config.tokenFile,
            };
          },
          logout: () => store.clear(),
        }
      : {}),
  });

  return { server, client, tokenProvider, cache, ledger, store, ...(ads ? { ads } : {}) };
};
