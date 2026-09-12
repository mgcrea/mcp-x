import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { Logger } from "#/logger";

export const DEFAULT_BASE_URL = "https://api.x.com";

export const DEFAULT_ADS_BASE_URL = "https://ads-api.x.com";

/**
 * The Ads API sandbox: free, isolated, and the only sane place to exercise the
 * write tools. Note the host — X's own docs say `ads-api-sandbox.x.com`, which
 * has no DNS record at all. `ads-api-sandbox.twitter.com` is the one that
 * resolves, so this is not a typo waiting to be "fixed".
 */
export const SANDBOX_ADS_BASE_URL = "https://ads-api-sandbox.twitter.com";

/**
 * A fixed loopback port, deliberately not an ephemeral one. Unlike most OAuth
 * providers, X matches the callback URL against the value registered in the
 * developer portal byte-for-byte, so a random port can never be authorized.
 */
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8723/callback";

/**
 * `offline.access` is what makes a refresh token come back at all — without it
 * the user has to re-login every two hours. `tweet.write` is appended at
 * startup when the paid write backend is enabled, so a read-only install never
 * asks for a permission it cannot use.
 */
export const DEFAULT_SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];

/**
 * X moved to pay-per-use on 2026-02-06; there is no free tier for new
 * developers. These are list prices in USD, overridable via the config file's
 * `pricing` key because a table baked into a schema with no escape hatch is
 * wrong the day X changes it.
 *
 * The 24h dedup window is the load-bearing rule: within one UTC day, re-reading
 * a resource id you already paid for is free. That is why the ledger keys on
 * (kind, id, utcDay) rather than counting requests.
 */
export const DEFAULT_PRICING = {
  postRead: 0.005,
  userRead: 0.01,
  /** Your own posts and profile — five times cheaper than reading someone else's. */
  ownedRead: 0.001,
  postCreate: 0.015,
  /** A post containing a URL costs 40x a post read. Not a typo. */
  postCreateWithUrl: 0.2,
  monthlyReadCap: 2_000_000,
  effectiveFrom: "2026-02-06",
};

const PricingSchema = z
  .object({
    postRead: z.number().nonnegative().default(DEFAULT_PRICING.postRead),
    userRead: z.number().nonnegative().default(DEFAULT_PRICING.userRead),
    ownedRead: z.number().nonnegative().default(DEFAULT_PRICING.ownedRead),
    postCreate: z.number().nonnegative().default(DEFAULT_PRICING.postCreate),
    postCreateWithUrl: z.number().nonnegative().default(DEFAULT_PRICING.postCreateWithUrl),
    monthlyReadCap: z.number().int().positive().default(DEFAULT_PRICING.monthlyReadCap),
    effectiveFrom: z.string().default(DEFAULT_PRICING.effectiveFrom),
  })
  .strict();

export type Pricing = z.infer<typeof PricingSchema>;

const ConfigSchema = z
  .object({
    bearerToken: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    redirectUri: z.string().min(1).default(DEFAULT_REDIRECT_URI),
    scopes: z.array(z.string().min(1)).min(1).default(DEFAULT_SCOPES),
    tokenFile: z.string().min(1),
    allowWrites: z.boolean().default(false),
    writeBackend: z.enum(["intent", "api"]).default("intent"),
    autoOpenBrowser: z.boolean().default(true),
    enableFullArchive: z.boolean().default(false),
    defaultMaxResults: z.number().int().min(1).max(100).default(10),
    monthlyBudgetUsd: z.number().nonnegative().optional(),
    cacheEnabled: z.boolean().default(true),
    cacheMaxEntries: z.number().int().min(0).max(100_000).default(5000),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    baseUrl: z.string().min(1).default(DEFAULT_BASE_URL),
    pricing: PricingSchema.default(DEFAULT_PRICING),
    adsEnabled: z.boolean().default(false),
    adsAllowWrites: z.boolean().default(false),
    adsBaseUrl: z.string().min(1).default(DEFAULT_ADS_BASE_URL),
    adsAccountId: z.string().min(1).optional(),
    adsMaxDownloadBytes: z.number().int().positive().default(25_000_000),
  })
  .strict();

/**
 * The resolved configuration plus everything `loadConfig` had to say about it.
 *
 * `warnings` is the channel for a misconfiguration that is *not* worth dying
 * over. The server once threw on three of them (the paid write backend
 * without a client id, ads without a client id, ads writes without ads) and
 * every one surfaced in the client as a bare "Connection closed" with the
 * explanation swallowed — the same failure the missing-credentials case had
 * already been cured of. Now the offending flag is switched off, the reason is
 * recorded here, and the banner and `x_get_auth_status` both print it.
 */
export type Config = z.infer<typeof ConfigSchema> & { warnings: string[] };

/**
 * The on-disk config document. Keys are camelCase to mirror `Config` rather than
 * the env var names: this is a typed JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `clientID` must be an error. Silently
 * ignoring an unknown key looks exactly like "that setting had no effect",
 * which is the worst way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    bearerToken: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    redirectUri: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).min(1).optional(),
    tokenFile: z.string().min(1).optional(),
    allowWrites: z.boolean().optional(),
    writeBackend: z.enum(["intent", "api"]).optional(),
    autoOpenBrowser: z.boolean().optional(),
    enableFullArchive: z.boolean().optional(),
    defaultMaxResults: z.number().int().min(1).max(100).optional(),
    monthlyBudgetUsd: z.number().nonnegative().optional(),
    cacheEnabled: z.boolean().optional(),
    cacheMaxEntries: z.number().int().min(0).max(100_000).optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    baseUrl: z.string().min(1).optional(),
    pricing: PricingSchema.optional(),
    adsEnabled: z.boolean().optional(),
    adsAllowWrites: z.boolean().optional(),
    adsBaseUrl: z.string().min(1).optional(),
    adsAccountId: z.string().min(1).optional(),
    adsMaxDownloadBytes: z.number().int().positive().optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];

/**
 * Parsers that report rather than swallow. `X_MONTHLY_BUDGET_USD=25usd`
 * silently meaning "no budget" is a spend ceiling the user believes is there
 * and is not; each of these hands the offending value to `warn` instead.
 */
type Warn = (message: string) => void;

const parseBool = (name: string, value: string | undefined, warn: Warn): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  const word = t.toLowerCase();
  if (TRUE_WORDS.includes(word)) return true;
  if (!FALSE_WORDS.includes(word)) {
    warn(
      `${name}="${t}" is not a recognised boolean (use 1/0, true/false, yes/no, on/off); treated as off.`,
    );
  }
  return false;
};

const parseIntOpt = (name: string, value: string | undefined, warn: Warn): number | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  const n = Number(t);
  if (Number.isInteger(n)) return n;
  warn(`${name}="${t}" is not a whole number; ignored.`);
  return undefined;
};

const parseFloatOpt = (name: string, value: string | undefined, warn: Warn): number | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  warn(`${name}="${t}" is not a number; ignored.`);
  return undefined;
};

/** A JSON object in an env var, for the one structured setting (`pricing`). */
const parseJsonObject = (name: string, value: string | undefined, warn: Warn): unknown => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    warn(`${name} must be a JSON object; ignored.`);
  } catch (err) {
    warn(`${name} is not valid JSON (${message(err)}); ignored.`);
  }
  return undefined;
};

/** Scopes are space-separated in OAuth but commas are what people actually type. */
const parseList = (value: string | undefined): string[] | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  const items = t
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `readFileSync` does not expand `~`, but it is the natural thing to write in a config file. */
export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/**
 * Where the config file lives, most specific first: an explicit override, then
 * the XDG location, then the conventional `~/.config`.
 */
export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.X_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "x", "config.json");
};

/** The OAuth token file sits beside the config file unless told otherwise. */
export const resolveTokenPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(dirname(resolveConfigPath(env)), "tokens.json");

/**
 * These files hold a bearer token or a refresh token, so being readable by
 * other users is worth saying out loud. It is a warning and not an error:
 * refusing to start would be a worse trade for someone on a single-user machine.
 */
export const warnIfGroupReadable = (path: string, logger?: Logger): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      logger?.warn?.(`[x] ${path} is readable by other users. Run: chmod 600 ${path}`);
    }
  } catch {
    // Not worth failing startup over; the read below reports anything that matters.
  }
};

/**
 * Read the config file, treating "absent" as "contributes nothing". Every other
 * failure throws and names the path, so a malformed file is never mistaken for
 * a missing one — that confusion would send you hunting for credentials that
 * were sitting right there.
 */
const readConfigFile = (path: string, logger?: Logger): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file (${path}): ${message(err)}`, { cause: err });
  }

  warnIfGroupReadable(path, logger);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The config file (${path}) is not valid JSON: ${message(err)}`, { cause: err });
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config file (${path}) is not valid: ${issues}`);
  }
  return result.data;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * Docker and CI inject the environment and must keep working untouched, while a
 * one-off `X_ALLOW_WRITES=0` still has to override a file that says `true`.
 * Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
  logger?: Logger,
): Config => {
  const file = readConfigFile(configPath, logger);
  const warnings: string[] = [];
  const warn: Warn = (msg) => warnings.push(msg);
  const bool = (name: string) => parseBool(name, env[name], warn);
  const int = (name: string) => parseIntOpt(name, env[name], warn);
  const float = (name: string) => parseFloatOpt(name, env[name], warn);

  const tokenFile = trimmed(env.X_TOKEN_FILE) ?? file.tokenFile ?? resolveTokenPath(env);
  const parsed = ConfigSchema.parse({
    bearerToken: trimmed(env.X_BEARER_TOKEN) ?? file.bearerToken,
    clientId: trimmed(env.X_CLIENT_ID) ?? file.clientId,
    clientSecret: trimmed(env.X_CLIENT_SECRET) ?? file.clientSecret,
    redirectUri: trimmed(env.X_REDIRECT_URI) ?? file.redirectUri,
    scopes: parseList(env.X_SCOPES) ?? file.scopes,
    tokenFile: expandTilde(tokenFile),
    allowWrites: bool("X_ALLOW_WRITES") ?? file.allowWrites,
    writeBackend: trimmed(env.X_WRITE_BACKEND) ?? file.writeBackend,
    autoOpenBrowser: bool("X_AUTO_OPEN_BROWSER") ?? file.autoOpenBrowser,
    enableFullArchive: bool("X_ENABLE_FULL_ARCHIVE") ?? file.enableFullArchive,
    defaultMaxResults: int("X_DEFAULT_MAX_RESULTS") ?? file.defaultMaxResults,
    monthlyBudgetUsd: float("X_MONTHLY_BUDGET_USD") ?? file.monthlyBudgetUsd,
    cacheEnabled: bool("X_CACHE_ENABLED") ?? file.cacheEnabled,
    cacheMaxEntries: int("X_CACHE_MAX_ENTRIES") ?? file.cacheMaxEntries,
    maxRetries: int("X_MAX_RETRIES") ?? file.maxRetries,
    baseUrl: trimmed(env.X_BASE_URL) ?? file.baseUrl,
    // The one structured setting. A Docker deployment cannot mount a config
    // file just to correct a price X changed, so it takes JSON in the env too.
    pricing: parseJsonObject("X_PRICING", env.X_PRICING, warn) ?? file.pricing,
    adsEnabled: bool("X_ADS_ENABLED") ?? file.adsEnabled,
    adsAllowWrites: bool("X_ADS_ALLOW_WRITES") ?? file.adsAllowWrites,
    adsBaseUrl: trimmed(env.X_ADS_BASE_URL) ?? file.adsBaseUrl,
    adsAccountId: trimmed(env.X_ADS_ACCOUNT_ID) ?? file.adsAccountId,
    adsMaxDownloadBytes: int("X_ADS_MAX_DOWNLOAD_BYTES") ?? file.adsMaxDownloadBytes,
  });

  return { ...degrade(parsed, warn), warnings };
};

/**
 * Switch off what cannot work, and say so, instead of refusing to start.
 *
 * Each of these used to be a fatal config error. They are contradictions, and
 * the messages are still written to be read — but read they must be, and a
 * server that exits at startup shows the client "Connection closed" and
 * nothing else. So the flag is turned off, the free tools stay up, and the
 * sentence lands in the banner and in `x_get_auth_status`, where it is seen.
 */
const degrade = (cfg: z.infer<typeof ConfigSchema>, warn: Warn): z.infer<typeof ConfigSchema> => {
  const out = { ...cfg };
  if (out.writeBackend === "api" && !out.clientId) {
    warn(
      "X_WRITE_BACKEND=api needs a user context: set X_CLIENT_ID and run `x-mcp login`. " +
        "Falling back to the intent backend, which needs no credentials at all — it returns an " +
        "x.com/intent/tweet URL you click, which costs nothing.",
    );
    out.writeBackend = "intent";
  }
  if (out.adsEnabled && !out.clientId) {
    warn(
      "X_ADS_ENABLED=1 needs an OAuth 2.0 user context: set X_CLIENT_ID and run `x-mcp login`. " +
        "The Ads API does not accept an app-only Bearer token, so the ads tools are not registered.",
    );
    out.adsEnabled = false;
  }
  if (out.adsAllowWrites && !out.adsEnabled) {
    warn(
      "X_ADS_ALLOW_WRITES=1 has no effect without X_ADS_ENABLED=1 — the ads tools are not " +
        "registered at all. Set both, or neither.",
    );
    out.adsAllowWrites = false;
  }
  return out;
};

/**
 * Whether the ads tools should be registered. The Ads API rides the same OAuth
 * 2.0 user token as bookmarks and the home timeline — the `ads.read` /
 * `ads.write` scopes are what separate them — so a client id is the hard
 * requirement, not a second set of credentials.
 */
export const hasAdsAccess = (config: Config): boolean =>
  config.adsEnabled && Boolean(config.clientId);

/** Whether anything at all is configured that can reach the X API. */
export const hasApiCredentials = (config: Config): boolean =>
  Boolean(config.bearerToken ?? config.clientId);

/**
 * What to do when nothing is configured. Returned by `x_get_auth_status` and
 * printed at startup, because this is the state a first-time user lands in and
 * the server can no longer signal it by refusing to start.
 */
export const setupInstructions = (config: Config): string[] => [
  "No X credentials are configured, so the tools that call the X API are not registered.",
  "The free local tools still work: x_compose_post (posts via a browser click, no credentials, " +
    "no cost), x_validate_post, and x_build_search_query.",
  // The portal moved with the February 2026 pricing change; developer.x.com is
  // legacy, and sending people there is the fastest way to lose them.
  "Create an app at https://console.x.com (this replaced the old developer.x.com portal). Both " +
    "credentials below are on the app's Keys and Tokens screen.",
  "To enable reading and search, set X_BEARER_TOKEN to the app's Bearer Token. That alone " +
    "covers post lookup, search, profiles and timelines — OAuth is not needed for any of it.",
  "To enable bookmarks, your home timeline and API writes, also set X_CLIENT_ID. When " +
    "creating the app choose Type of App = Native App: that makes it a public PKCE client with " +
    `no client secret, which is what this server expects. Register the callback URL ` +
    `${config.redirectUri} byte for byte (X's docs say to use 127.0.0.1 rather than localhost), ` +
    "then run `x-mcp login` or call x_login.",
  "Enroll the app in the Pay-per-use package and the Production environment. An app left in the " +
    "legacy Free/Development state logs in successfully and then fails every call with 403 " +
    "client-not-enrolled.",
  "Note that X removed its free tier on 2026-02-06: creating an app is free, but reads are " +
    "pay-per-use and need prepurchased credits in the console.",
];

/**
 * What to do when ads is enabled but the account cannot reach the Ads API.
 * Surfaced by `x_get_auth_status`, because the two steps people miss are invisible
 * from the error alone: the app needs the Ads Project attached, and any token
 * minted *before* approval does not carry the entitlement.
 */
export const adsSetupInstructions = (config: Config): string[] => [
  "The Ads API is separate from the X API v2: it needs its own approval, even though it uses " +
    "the same OAuth 2.0 login.",
  "At https://console.x.com open your app, then Project Access → MANAGE → Ads Project. That " +
    "attaches Ads API access to the app id.",
  "Request Ads API access for the app using X's Ads API Access Form. Standard Access covers " +
    "campaigns, creatives, audiences and analytics.",
  // The step everyone misses. An old token authenticates fine and then fails
  // every ads call, which reads as a scope problem and is not one.
  "After approval is granted, run `x-mcp login` again. A token minted before approval " +
    "does not carry the entitlement, and re-using it fails every call.",
  `Ads calls are billed separately from X's pay-per-use reads, so they do not appear in ` +
    `x_get_usage_report — but the campaigns they manage spend your advertising budget.`,
  `Point X_ADS_BASE_URL at ${SANDBOX_ADS_BASE_URL} for a free sandbox before touching a live ` +
    `account. Set X_ADS_ALLOW_WRITES=1 to register the campaign-mutating tools; without it they ` +
    `do not exist.`,
  ...(config.adsAccountId
    ? []
    : [
        "X_ADS_ACCOUNT_ID is unset. That is fine when you have exactly one ads account — it is " +
          "resolved automatically — but with several you must pass accountId per call or set it.",
      ]),
];

/**
 * The scopes actually requested at login. `tweet.write` is only asked for when
 * the paid write backend is on, so a reader never holds a permission it cannot
 * use — and the consent screen stays honest about what the server will do.
 */
export const effectiveScopes = (config: Config): string[] => {
  const scopes = [...config.scopes];
  if (config.allowWrites && config.writeBackend === "api") {
    if (!scopes.includes("tweet.write")) scopes.push("tweet.write");
    // Article images and covers go through the media upload endpoint.
    if (!scopes.includes("media.write")) scopes.push("media.write");
  }
  // Same rule for ads: ask for read access only when the tools are registered,
  // and for write access only when the write tools are. A read-only ads install
  // never puts "manage your ad campaigns" on the consent screen.
  if (config.adsEnabled && !scopes.includes("ads.read")) scopes.push("ads.read");
  if (config.adsEnabled && config.adsAllowWrites && !scopes.includes("ads.write")) {
    scopes.push("ads.write");
  }
  return scopes;
};

/**
 * Asked for at login, never demanded of a stored token. A stored token missing
 * a required scope is treated as no login at all, for every call — so making
 * `media.write` required when Article images arrived would have signed out
 * every existing API-write install, reads included, over a scope that only an
 * image upload uses. An upload X refuses says to run x_login again instead.
 */
export const OPTIONAL_SCOPES: readonly string[] = ["media.write"];

/** The scopes a stored token must hold to be used at all. */
export const requiredScopes = (config: Config): string[] =>
  effectiveScopes(config).filter((scope) => !OPTIONAL_SCOPES.includes(scope));
