#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { startLoginFlow } from "#/client/oauth";
import { openInBrowser } from "#/compose/open";
import {
  hasAdsAccess,
  hasApiCredentials,
  loadConfig,
  resolveConfigPath,
  setupInstructions,
} from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.X_DEBUG) console.error("[x-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[x-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[x-mcp]", ...args),
};

/**
 * The ads segment of the startup banner. It spells out the environment because
 * "LIVE+writes" scrolling past is the last chance anyone has to notice before
 * an agent changes a campaign that spends real money.
 */
const describeAds = (config: ReturnType<typeof loadConfig>): string => {
  if (!hasAdsAccess(config)) return "off";
  const env = /ads-api-sandbox\./.test(config.adsBaseUrl) ? "SANDBOX" : "LIVE";
  return `${env}${config.adsAllowWrites ? "+writes" : " read-only"}`;
};

const describeAuth = (config: ReturnType<typeof loadConfig>): string => {
  const parts: string[] = [];
  if (config.bearerToken) parts.push("bearer");
  if (config.clientId) parts.push("oauth2");
  return parts.length > 0 ? parts.join("+") : "none";
};

/**
 * `login` / `logout` / `status` run and exit; anything else starts the stdio
 * server. Handled before the transport is created, so these never write to the
 * protocol channel.
 */
const runSubcommand = async (command: string): Promise<boolean> => {
  if (!["login", "logout", "status"].includes(command)) return false;

  const config = loadConfig(process.env, resolveConfigPath(), stderrLogger);
  for (const line of config.warnings) stderrLogger.warn(line);
  const { store, tokenProvider } = createServer({ config, logger: stderrLogger });

  if (command === "status") {
    const status = tokenProvider.describe();
    console.error(
      `ads: ${describeAds(config)}${hasAdsAccess(config) ? ` (${config.adsBaseUrl})` : ""}`,
    );
    console.error(`app-only bearer: ${status.app ? "configured" : "not configured"}`);
    console.error(
      status.user.authenticated
        ? `oauth2 user: @${status.user.username ?? "?"} (scopes: ${status.user.scopes.join(", ")}, ` +
            `expires ${new Date(status.user.expiresAt).toISOString()})`
        : `oauth2 user: not authenticated — ${status.user.reason}`,
    );
    console.error(`token file: ${config.tokenFile}`);
    return true;
  }

  if (command === "logout") {
    store.clear();
    console.error(`Removed ${config.tokenFile}. The app-only Bearer token is unaffected.`);
    return true;
  }

  if (!config.clientId) {
    console.error(
      "Cannot log in: X_CLIENT_ID is not set. Create an OAuth 2.0 app in the X developer " +
        `portal, enable PKCE, and register this exact callback URL: ${config.redirectUri}`,
    );
    process.exit(1);
  }

  const { tokens } = await startLoginFlow({
    config,
    store,
    // Honour X_AUTO_OPEN_BROWSER here too: on a headless box the printed URL
    // is the whole flow, and an xdg-open attempt is only noise.
    ...(config.autoOpenBrowser ? { openBrowser: openInBrowser } : {}),
    logger: stderrLogger,
  });
  console.error(
    `Logged in as @${tokens.username ?? "?"} (scopes: ${tokens.scopes.join(", ")}). ` +
      `Refresh token stored in ${config.tokenFile} with mode 600.`,
  );
  return true;
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );

  const command = process.argv[2];
  if (command && (await runSubcommand(command))) return;

  const config = loadConfig(process.env, resolveConfigPath(), stderrLogger);
  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // A flag that was switched off is worth one line each, right under the
  // banner that shows it off — the server no longer exits over these.
  for (const line of config.warnings) stderrLogger.warn(`config: ${line}`);

  stderrLogger.warn(
    `x-mcp connected (auth=${describeAuth(config)}, ` +
      `writes=${config.allowWrites ? `ENABLED via ${config.writeBackend}` : "disabled"}, ` +
      `compose=intent (free), ` +
      `full-archive=${config.enableFullArchive ? "on" : "off"}, ` +
      `ads=${describeAds(config)}, ` +
      `cache=${config.cacheEnabled ? "on" : "off"})`,
  );

  // Connecting successfully but exposing only four tools is confusing unless we
  // say why. The server no longer refuses to start over this, so the banner and
  // x_get_auth_status are the only channels left.
  if (!hasApiCredentials(config)) {
    for (const line of setupInstructions(config)) stderrLogger.warn(line);
    stderrLogger.warn("Call the x_get_auth_status tool for this same guidance inside your client.");
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

/**
 * A misconfiguration is the most likely first-run failure, and the config
 * schema's messages are written to be read. Dumping a raw ZodError with a stack
 * trace buries them, so unwrap it to just the messages — the stack tells the
 * user nothing they can act on.
 */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

main().catch((err: unknown) => {
  console.error(`[x-mcp] ${describeFatal(err)}`);
  if (process.env.X_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
