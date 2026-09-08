import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fileMode } from "#/client/tokens";
import type { ToolContext } from "#/tools/index";
import { fail, wrap } from "#/tools/util";

/**
 * What `x_login` says when there is no client id to log in with.
 *
 * Names the variable and the callback in one breath because they fail
 * together: X matches `redirect_uri` byte for byte, and under a supervisor the
 * port is assigned per profile — so the URL to register is this profile's, not
 * the one in anybody's notes.
 */
const unconfigured = (redirectUri: string): string =>
  "No OAuth2 client id is configured, so there is no app to log in to. Set X_CLIENT_ID to your " +
  "app's OAuth 2.0 Client ID from https://console.x.com, then call x_login again. Choose Type " +
  "of App = Native App when creating it: that makes it a public PKCE client, which is what this " +
  `server expects. Register ${redirectUri} as the app's callback URL, byte for byte.`;

/**
 * The auth tools double as the "Authenticate button" for supervisors that
 * have one. Bastion drives a child server's login through exactly three tools
 * it calls with no arguments — status, login, logout — and reads one field
 * from the status reply: a top-level boolean `signedIn`. Everything else here
 * is for a human or a model. Keep those three shapes stable.
 *
 * All three are registered UNCONDITIONALLY, including with no client id
 * configured. A supervisor calls them by name off its own catalog rather than
 * off this server's tool list, so hiding one does not hide the button that
 * calls it: the click reaches a server that never registered `x_login` and
 * comes back as the SDK's `Tool x_login not found` — a protocol error naming
 * a tool the user cannot see, about a cause it does not mention. One extra
 * entry in the listing buys the sentence that actually fixes it.
 */
export const registerAuthTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "x_get_auth_status",
    {
      title: "X: Get Auth Status",
      description:
        "Which credentials this server is holding: an app-only Bearer token (enough for public " +
        "reads and search), an OAuth2 user session (needed for bookmarks, the home timeline, " +
        "API writes and Ads), or neither. Shows the logged-in handle, granted scopes, token " +
        "expiry, the callback URL a login expects, whether the Ads API tools are registered and " +
        "against which environment, and any setting that was switched off at startup. Call this " +
        "first if the X API tools seem to be missing — it explains exactly what to configure.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      wrap(async () => {
        const status = ctx.tokenProvider.describe();
        const mode = ctx.tokenFile ? fileMode(ctx.tokenFile) : undefined;
        const warnings = ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {};

        // The state a first-time user lands in. Answer it as a setup guide
        // rather than a status dump, since the server can no longer signal this
        // by refusing to start.
        if (!ctx.hasCredentials) {
          return {
            configured: false,
            signedIn: false,
            app_only_bearer: false,
            user: { authenticated: false, reason: "no credentials configured" },
            can_read_public: false,
            can_read_bookmarks: false,
            available_without_credentials: [
              "x_compose_post",
              "x_validate_post",
              "x_build_search_query",
              "x_get_auth_status",
            ],
            setup: ctx.setup ?? [],
            ...warnings,
          };
        }

        return {
          configured: true,
          // The one field a supervisor reads. Everything else is prose for a
          // person or a model; this is the contract.
          signedIn: status.user.authenticated,
          app_only_bearer: status.app,
          user: status.user.authenticated
            ? {
                ...status.user,
                expires_at: new Date(status.user.expiresAt).toISOString(),
                expires_in_seconds: Math.max(
                  0,
                  Math.round((status.user.expiresAt - Date.now()) / 1000),
                ),
              }
            : status.user,
          ...(ctx.login
            ? {
                oauth: {
                  // Under a supervisor the callback port is assigned per
                  // profile; this is the exact URL to register with the X app.
                  redirect_uri: ctx.redirectUri,
                  ...(ctx.tokenFile
                    ? {
                        token_file: {
                          path: ctx.tokenFile,
                          mode: mode === undefined ? "absent" : `0${mode.toString(8)}`,
                          ...(mode !== undefined && (mode & 0o077) !== 0
                            ? {
                                warning: `Readable by other users. Run: chmod 600 ${ctx.tokenFile}`,
                              }
                            : {}),
                        },
                      }
                    : {}),
                  ...(status.user.authenticated
                    ? {}
                    : {
                        next_step:
                          `Register ${ctx.redirectUri} as the app's callback URL at console.x.com ` +
                          `if you have not yet, then call x_login (or press Sign in in Bastion).`,
                      }),
                },
              }
            : {}),
          can_read_public: status.app || status.user.authenticated,
          can_read_bookmarks: status.user.authenticated,
          ads: ctx.ads
            ? {
                enabled: true,
                environment: ctx.ads.sandbox ? "sandbox" : "production",
                base_url: ctx.ads.baseUrl,
                writes_enabled: ctx.ads.allowWrites,
                default_account_id: ctx.ads.accountId ?? null,
                note: ctx.ads.sandbox
                  ? "Sandbox — campaigns here spend nothing."
                  : "PRODUCTION — these tools read and can change campaigns that spend real money.",
              }
            : {
                enabled: false,
                reason: ctx.adsSetup
                  ? "X_ADS_ENABLED is not set."
                  : "no OAuth2 client id configured",
                ...(ctx.adsSetup ? { setup: ctx.adsSetup } : {}),
              },
          ...warnings,
        };
      }),
  );

  const login = ctx.login;

  server.registerTool(
    "x_login",
    {
      title: "X: Login",
      description:
        "Start the OAuth2 login. Prints a URL (and opens your browser) for you to authorize the " +
        "app, waits up to two minutes for the callback, then stores a refresh token in the token " +
        "file with mode 600. Only needed for bookmarks, the home timeline, API writes and Ads — " +
        "public reads and search work with the Bearer token alone. Needs X_CLIENT_ID set, and " +
        "the callback URL shown by x_get_auth_status registered with the X app first; without " +
        "either it refuses with what to fix. Under Bastion, the Sign in button in the profile " +
        "editor calls this tool.",
      inputSchema: z.object({
        open: z.boolean().default(true).describe("Open the authorize URL in your browser."),
      }),
      // Not readOnly (it opens a browser and writes a token file), but deliberately
      // NOT gated behind allowWrites: logging in changes nothing on X, and gating
      // it would leave a read-only install unable to see its own account.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ open }) => {
      if (!login) return fail(unconfigured(ctx.redirectUri));
      return wrap(async () => {
        const result = await login(open);
        return {
          signedIn: true,
          username: result.username,
          userId: result.userId,
          scopes: result.scopes,
          token_file: result.tokenFile,
          note:
            "The refresh token is stored with mode 600 and rotates on every refresh. The tools " +
            "that need a user session were already registered, so no restart is needed.",
        };
      });
    },
  );

  server.registerTool(
    "x_logout",
    {
      title: "X: Logout",
      description:
        "Delete the stored OAuth2 tokens. The app-only Bearer token is unaffected, so public " +
        "reads and search keep working. Undo it by logging in again. This does not revoke the " +
        "app on X's side — do that at x.com/settings/connected_apps.",
      // No `confirm`: a supervisor's Sign out calls this with no arguments, and
      // the action is recoverable in the time it takes to log in again.
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async () =>
      wrap(async () => {
        const had = ctx.tokenProvider.describe().user.authenticated;
        ctx.logout?.();
        return {
          signedOut: had,
          signedIn: false,
          note: had
            ? "Refresh token deleted. Public reads and search continue to work if a Bearer token is configured."
            : "No login was stored.",
        };
      }),
  );
};
