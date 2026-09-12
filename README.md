# @mgcrea/mcp-x

[![npm version](https://img.shields.io/npm/v/@mgcrea/mcp-x.svg)](https://www.npmjs.com/package/@mgcrea/mcp-x)
[![ci](https://github.com/mgcrea/mcp-x/actions/workflows/ci.yml/badge.svg)](https://github.com/mgcrea/mcp-x/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@mgcrea/mcp-x.svg)](./LICENSE)

Model Context Protocol server for the **X (Twitter) API v2** — built for reading and searching posts.

> **Unofficial.** Not affiliated with, endorsed by, or supported by X Corp.

## Features

- **A serious reader.** Post lookup, recent and full-archive search, profiles, user timelines, thread reconstruction, bookmarks and your home timeline — with X's query syntax exposed properly.
- **Readable output.** X returns posts whose author, quoted post and real URLs live in a separate `includes` sidecar. Every tool here resolves that first, so posts arrive with the handle inline, t.co links expanded, and retweets showing the original text.
- **Free posting.** `x_compose_post` returns an [`x.com/intent/tweet`](https://docs.x.com/x-for-websites/post-button/guides/web-intent) URL you click. No credentials, no API quota, no cost — and nothing publishes without a human click.
- **X Articles, kept in sync with their source.** Read any Article in full, check a published one against the Markdown it came from, and — behind the write flags — draft and publish new ones from Markdown, images included. X's API cannot edit a published Article, so `x_compare_article` tells you exactly what to change in X's editor. See [Articles](#articles).
- **Cost-aware by design.** X is pay-per-use. Every read reports what it cost, repeat reads inside a UTC day are free, and a budget ceiling stops a runaway loop before the request goes out.
- **Ads, when you ask for it.** Campaigns, line items, targeting, audiences and performance analytics through the [X Ads API](https://docs.x.com/x-ads-api/introduction). Needs its own approval from X and is off unless configured; campaign writes are a second switch again, and anything created starts PAUSED.
- **Official API only.** No cookie scraping, no password automation, nothing that risks your account.

## Cost — read this first

**X removed its tiered pricing on 2026-02-06. There is no free tier for new developers**, and much of the ecosystem's documentation still says otherwise. Current list prices:

| Action                                            | Price     |
| ------------------------------------------------- | --------- |
| Read a post                                       | ~$0.005   |
| Read a user profile                               | ~$0.010   |
| Read **your own** data (bookmarks, home timeline) | ~$0.001   |
| Create a post                                     | ~$0.015   |
| Create a post **containing a URL**                | ~$0.200   |
| Monthly read cap                                  | 2,000,000 |

Credits are prepurchased in the developer console; at zero credits, requests are blocked. Three things follow, and they shape the whole server:

1. **`maxResults` defaults to 10, not 50.** A 100-result search is about $0.50.
2. **Repeat reads are free.** X deduplicates per resource id within a UTC calendar day, so the built-in cache mirrors that exactly — a cache hit is genuinely free, not merely fast.
3. **Posting should not cost anything.** `x_compose_post` is the default write path and uses a web intent. The paid `x_create_post` stays unregistered unless you opt in twice (`X_ALLOW_WRITES=1` **and** `X_WRITE_BACKEND=api`).

Run `x_count_recent` before a broad search — it returns totals without reading any posts, so it costs nothing and tells you what the search would cost. `x_build_search_query` is likewise free and local.

> Prices are X's published list rates, transcribed 2026-07-19. Override them via the config file's `pricing` key, or `X_PRICING` as a JSON object, if they change. `x_get_usage_report` estimates locally and is not authoritative — the developer portal is.

**Ads is billed elsewhere.** Ads API calls are not metered by X's pay-per-use read pricing, so they cost nothing and never appear in `x_get_usage_report`. What they manage does: a campaign spends your advertising budget, on X's invoice rather than the API's, and no tool here can see that number. Treat `x_get_usage_report` as silent on ads rather than as reporting zero.

**Articles are unpriced.** X publishes no rate for its Articles or media upload endpoints (checked 2026-09-12), so creating a draft, uploading its images and publishing it are not estimated and do not appear in `x_get_usage_report`. Reading an Article is an ordinary post read.

## Security

- **Supply chain.** Two runtime dependencies: the MCP SDK and zod. The HTTP layer is hand-rolled `fetch` — no HTTP library, no logger, nothing else on the tree.
- **Verified builds.** npm releases carry [provenance](https://docs.npmjs.com/generating-provenance-statements) via OIDC trusted publishing; container images are multi-arch, ship an SBOM, and are signed with [cosign](https://docs.sigstore.dev/cosign/signing/overview/).
- **Your credentials.** Read from the environment or a config file you control, sent only to `api.x.com` (and `ads-api.x.com` when ads is enabled), never logged. The one other host ever contacted is `ton.twimg.com`, where X serves finished analytics reports — those downloads carry no credential at all, and any other host in a report URL is refused. The **one** file this server writes is `tokens.json` (mode 600), and only if you use OAuth — it has to persist a rotating refresh token. Everything else is read-only. Every request has a 30-second deadline, and a rate-limit window longer than 30 seconds is reported rather than waited out.
- **Blast radius.** Paid writes are off by default and _unregistered_ rather than refused, so an agent cannot call what does not exist. The free compose path never publishes without a human clicking Post. Ads writes are a separate switch on the same principle, campaigns and line items are created `PAUSED` unless a call explicitly asks otherwise, and budgets are taken in major currency units — the ×1,000,000 mistake is not expressible.
- **Local files.** The Article tools read the Markdown file and images you name, and nothing else: a `.md`, `.markdown` or `.mdx` file by absolute path, and images only when their content — not their name — is a PNG, JPEG or WebP under 5 MB. A key file renamed `cover.png` is refused before any request. Only `x_create_article_draft` sends what it reads to X.
- **No scraping.** This server never touches session cookies or your password. Tools that do are a ban risk regardless of how they are marketed.

## Configure

**The server starts with no configuration at all.** In that state it registers only the tools that need no credentials — `x_compose_post`, `x_validate_post`, `x_validate_article`, `x_build_search_query` and `x_get_auth_status` — and `x_get_auth_status` tells you exactly what to set for the rest. It never refuses to start over missing credentials, because an MCP server that exits shows up in the client as a bare `Connection closed` with the explanation swallowed. The same goes for a contradiction between flags (`X_ADS_ENABLED` without a client id, say): the flag is switched off, and the reason is printed at startup and returned by `x_get_auth_status` under `warnings`.

To read anything, one variable is required:

```bash
export X_BEARER_TOKEN="..."   # console.x.com → your app → Keys and Tokens
```

That covers every public read: lookup, search, profiles, timelines — no OAuth needed. See [Getting credentials](#getting-credentials) below, and [.env.example](./.env.example) for the rest. The ones worth knowing by name:

| Variable                | Meaning                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X_BEARER_TOKEN`        | App-only Bearer token. Every public read.                                                                                                              |
| `X_CLIENT_ID`           | OAuth 2.0 client id. Bookmarks, home timeline, API writes, Ads.                                                                                        |
| `X_MONTHLY_BUDGET_USD`  | Spend ceiling for this process. A read whose estimate would cross it is refused before the request goes out.                                           |
| `X_DEFAULT_MAX_RESULTS` | Default page size for every read tool (10).                                                                                                            |
| `X_PRICING`             | JSON object overriding the price table, for deployments with no config file.                                                                           |
| `X_ALLOW_WRITES`        | With `X_WRITE_BACKEND=api`, registers the paid `x_create_post` / `x_delete_post` and the Article draft and publish tools, and lets `x_request` mutate. |
| `X_ENABLE_FULL_ARCHIVE` | Registers `x_search_all`.                                                                                                                              |
| `X_ADS_ENABLED`         | Registers the Ads API tools (needs `X_CLIENT_ID`).                                                                                                     |
| `X_ADS_ALLOW_WRITES`    | Registers the campaign-mutating Ads tools.                                                                                                             |
| `X_ADS_ACCOUNT_ID`      | The ads account to act on. Optional with exactly one account; with several, a call without `accountId` is refused.                                     |
| `X_ADS_BASE_URL`        | Point at the sandbox (see below) before touching a live account.                                                                                       |

### Getting credentials

Create an app at **[console.x.com](https://console.x.com)** — this replaced the old `developer.x.com` portal, and the legacy URL is a common dead end. Sign in, accept the Developer Agreement, then **New App**.

Settings that matter:

| Setting                   | Value                            | Why                                                                                                                                                                    |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type of App**           | **Native App**                   | Native App and Single Page App are _public_ clients — PKCE, no client secret. Web App and Automated App are confidential and issue a secret this server does not want. |
| **App permissions**       | Read _(or Read and write)_       | Read covers search and bookmarks. Changing this later forces every user to re-authorize.                                                                               |
| **Callback URI**          | `http://127.0.0.1:8723/callback` | Must match byte for byte. X's docs say to use `127.0.0.1`, not `localhost`, for local development.                                                                     |
| **Package / Environment** | **Pay-per-use / Production**     | See the warning below.                                                                                                                                                 |

Both credentials appear on the app's **Keys and Tokens** screen: the **Bearer Token** and the **Client ID**.

> **The enrollment trap.** An app left in the legacy Free package or the Development environment logs in successfully and then fails _every_ user-context call with `403 client-not-enrolled`. If that happens, open the app at console.x.com and move it to Pay-per-use / Production. X's own `xurl` CLI documents this as the fix.

Creating an app and getting credentials appears to be free; **making calls is not** — there has been no free tier since 2026-02-06, so you need prepurchased credits before any read succeeds.

**OAuth 2.0** is needed only for bookmarks, your home timeline, and API writes:

```bash
export X_CLIENT_ID="..."      # the Client ID of a Native App (public PKCE client)
npx @mgcrea/mcp-x login       # opens a browser, stores a refresh token (mode 600)
```

Or, from inside a client, call `x_login`. Under [Bastion](https://github.com/mgcrea/bastion) the profile editor's **Sign in with X** button does the same through the server's own tools — Bastion assigns the callback port per profile, so read the URL from `x_get_auth_status` and register that exact one with the app.

### Ads API access

The Ads API is a separate product behind a separate approval, even though it uses the same OAuth 2.0 login. Three steps, in order:

1. At [console.x.com](https://console.x.com), open the app → **Project Access** → **MANAGE** → select **Ads Project**. This attaches Ads API access to the app id.
2. Request Ads API access for that app using X's **Ads API Access Form**. Standard Access covers campaigns, creatives, audiences and analytics.
3. Once approved, run `x-mcp login` **again**, then set `X_ADS_ENABLED=1`.

> **The regenerate trap.** A token minted _before_ your Ads API approval does not carry the entitlement. It logs in fine, reads posts fine, and then fails every ads call — which reads as a scope problem and is not one. If ads calls fail right after approval, log in again before debugging anything else.

Your X user also needs a role on at least one ads account, granted in [ads.x.com](https://ads.x.com) rather than the developer console — the API only ever sees accounts you can already see there.

Exercise the write tools against the free sandbox first:

```bash
export X_ADS_ENABLED=1
export X_ADS_ALLOW_WRITES=1
export X_ADS_BASE_URL=https://ads-api-sandbox.twitter.com   # note: not .x.com, which does not resolve
```

Campaigns and line items are created `PAUSED` unless a call passes `activateImmediately: true`, and every budget is given in major currency units — `50` means 50.00, never 50000000.

### Config file

Instead of environment variables, use `~/.config/x/config.json` (camelCase keys, the env names minus the `X_` prefix). Environment wins **per field**, so a one-off `X_ALLOW_WRITES=0` still overrides a file that says `true`. Unknown keys are an error rather than silently ignored.

```json
{
  "bearerToken": "...",
  "defaultMaxResults": 10,
  "monthlyBudgetUsd": 25
}
```

## Quick start

**A. npx**

```json
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-x"],
      "env": { "X_BEARER_TOKEN": "..." }
    }
  }
}
```

**B. Docker (stdio)**

```json
{
  "mcpServers": {
    "x": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "X_BEARER_TOKEN", "ghcr.io/mgcrea/mcp-x"],
      "env": { "X_BEARER_TOKEN": "..." }
    }
  }
}
```

**C. From source**

```bash
pnpm install && pnpm build
X_BEARER_TOKEN=... node dist/cli.js
```

**Inspect the tools**

```bash
X_BEARER_TOKEN=... npx @modelcontextprotocol/inspector node dist/cli.js
```

## Tools

Writes are marked `*`, and `†` means a `confirm: true` argument is required. Tools that do not apply to your configuration are not registered at all.

**Posts** — `x_get_post` · `x_get_posts` (batch up to 100 in one request) · `x_get_thread` · `x_get_quotes`

**Users** — `x_get_user` · `x_get_users` · `x_get_user_posts` · `x_get_user_mentions`

**Search** — `x_search_recent` · `x_count_recent` (free — totals only) · `x_build_search_query` (free — local) · `x_search_all` _(needs `X_ENABLE_FULL_ARCHIVE`)_

**Compose** — `x_validate_post` (free, local) · `x_compose_post` (free, web intent) · `x_create_post` \*† · `x_delete_post` \*† _(the last two need `X_ALLOW_WRITES=1` **and** `X_WRITE_BACKEND=api`)_

**Articles** — `x_get_article` · `x_compare_article` · `x_validate_article` (free, local) · `x_create_article_draft` \*† · `x_publish_article` \*† _(the last two need `X_ALLOW_WRITES=1` **and** `X_WRITE_BACKEND=api`)_

**Timelines** — `x_get_home_timeline` · `x_get_bookmarks` _(need OAuth login; X serves these for your own account only)_

**Auth** — `x_get_auth_status` · `x_login` \* · `x_logout` \* _(the last two need `X_CLIENT_ID`)_

**Ads — reads** — `x_ads_get_accounts` · `x_ads_get_funding_instruments` · `x_ads_get_campaigns` · `x_ads_get_line_items` · `x_ads_get_promoted_tweets` · `x_ads_get_targeting_criteria` · `x_ads_search_targeting_options` · `x_ads_get_audiences` · `x_ads_get_stats` · `x_ads_create_stats_job` · `x_ads_get_stats_jobs` · `x_ads_download_stats_job` _(need `X_ADS_ENABLED` and an OAuth login)_

**Ads — writes** \* † — `x_ads_create_campaign` · `x_ads_update_campaign` · `x_ads_delete_campaign` · `x_ads_create_line_item` · `x_ads_update_line_item` · `x_ads_delete_line_item` · `x_ads_create_targeting_criterion` · `x_ads_delete_targeting_criterion` · `x_ads_create_promoted_tweet` · `x_ads_delete_promoted_tweet` · `x_ads_set_entity_status` _(need `X_ADS_ALLOW_WRITES=1`)_ · `x_ads_create_sandbox_account` _(sandbox only)_

**Usage** — `x_get_usage_report` · `x_get_rate_limit_status`

**Escape hatch** — `x_request` — any `/2/` or `/12/` endpoint this server does not wrap, returned raw. GET only until a write gate is on; a mutation additionally takes `confirm: true`. Reads made here are billed by X but not counted by `x_get_usage_report`.

### Reading posts

Ask for a post and you get it resolved, not raw:

```json
{
  "post": {
    "id": "1799000000000000001",
    "url": "https://x.com/mgcrea/status/1799000000000000001",
    "author": "@mgcrea (Olivier)",
    "text": "Shipping v2 today https://acme.dev/v2",
    "metrics": { "likes": 88, "reposts": 12, "replies": 3, "quotes": 1, "views": 10400 },
    "quotes": { "id": "1798…", "author": "@acme (Acme Inc)", "text": "v1 was great." },
    "media": ["photo: https://pbs.twimg.com/media/x.jpg (alt: release notes screenshot)"]
  },
  "cost": { "billable_post_reads": 1, "free_from_cache": 0, "estimated_usd": 0.005 }
}
```

The `includes` sidecar, `entities`, `edit_history_tweet_ids` and `author_id` never appear — the join is already done, so the model cannot get it wrong.

### Searching without overspending

The cheapest workflow is free until the last step:

1. `x_build_search_query` — turn a description into `rust (from:a OR from:b) lang:en -is:retweet`, with each operator explained. Local, $0.
2. `x_count_recent` — how many posts match, and what reading them all would cost. Totals only, $0.
3. `x_search_recent` — actually read them, at ~$0.005 each.

### Posting for free

`x_compose_post` validates the draft against X's **weighted** 280-character limit (every URL counts 23 whatever its length; CJK characters and emoji count 2, so 140 Japanese characters is already full) and hands back a URL:

```json
{
  "intent_url": "https://x.com/intent/tweet?text=Shipping+v2+today&url=https%3A%2F%2Facme.dev%2Fv2",
  "opened": true,
  "weighted_length": 41,
  "remaining": 239,
  "cost": { "estimated_usd": 0, "note": "Web intent — no API call, no quota consumed." }
}
```

The URL comes back whether or not a browser could be opened, so Docker and SSH behave identically.

**Web intents cannot** attach media, create polls, make native quote posts, or build threads — those need the paid API. Replying to a post _does_ work (`inReplyTo`).

### Articles

X Articles are the long-form posts with a title, headings and images. The API behind them is small and lopsided, and that decides how these tools work:

- **Reading** is an ordinary post lookup. `x_get_article` returns the title, the whole body (paged with `offset` — an Article can run past 50,000 characters), the cover, and the images, links and posts it embeds, for one post read. Every other read marks an Article post with `article.title`, since its own text is only a link.
- **Writing** is two endpoints: create a draft, publish a draft. There is no update, no delete, and no way to read a draft back — so **a published Article cannot be edited through the API.** X's web editor can.
- **Keeping a copy in sync** is therefore a comparison, not a push. `x_compare_article` converts your Markdown exactly as a draft would, reads the Article, and lists only the title and paragraphs that differ, each anchored to the unchanged paragraph before it — the edits to make in X's editor. Whitespace and curly quotes are ignored; images, links and formatting are not compared.
- **Drafting from Markdown** is checked locally first. `x_validate_article` is free and shows the title, the outline, each image and everything an Article cannot express. `x_create_article_draft` then uploads each local image and the cover and creates the draft, and `x_publish_article` makes it public.

What converts: headings (h4–h6 become level three), bold, italic, strikethrough, links, lists (flattened — Articles have no nesting), quotes, dividers, and code blocks and tables (as X's markdown blocks, capped at 10,000 weighted characters per Article). An image, or an `x.com/…/status/…` link, on a line of its own becomes an embed. Inline code loses its style. Front matter supplies `title` and `cover`, and relative image paths resolve against the Markdown file, as a site generator reads them. Relative links (`/blog/next-post`) resolve against `linkBaseUrl`, your site's address, when you pass it; without it they keep their text and lose the link.

Before drafting:

- The posting account needs **X Premium**.
- Images must be local PNG, JPEG or WebP files up to 5 MB. Remote URLs are not downloaded for you.
- Uploads need the `media.write` scope. It is requested at login whenever writes are on, but a login made before this version lacks it — run `x_login` again. It is deliberately not _required_ of a stored token, so an older login keeps working for everything else in the meantime.

## Troubleshooting

**`MCP error -32000: Connection closed`** — the server process died on startup. It does _not_ do this for missing credentials (see [Configure](#configure)), so check, in order:

1. The command actually resolves. `@mgcrea/mcp-x` must be published for the `npx` form to work; while developing, point at a built file: `"command": "node", "args": ["/absolute/path/to/dist/cli.js"]`. A relative `./dist/cli.js` depends on the client's working directory.
2. You ran `pnpm build` — `dist/cli.js` has to exist.
3. Run it by hand to see stderr, which MCP clients swallow: `X_BEARER_TOKEN=... node dist/cli.js`. A config error prints one readable line; add `X_DEBUG=1` for the stack.

**Only the free local tools show up** — no credentials are configured. Call `x_get_auth_status`; it returns the setup steps.

**I want OAuth but see no way in** — OAuth needs an app you register. See [Getting credentials](#getting-credentials): create a **Native App** at console.x.com, set `X_CLIENT_ID` to its Client ID, register the callback, then run `npx @mgcrea/mcp-x login` (or call `x_login`). There is no way to log in without a client id — X has nothing to authorize against.

**`403 client-not-enrolled` right after a successful login** — the app is in the legacy Free package or the Development environment. Move it to **Pay-per-use / Production** at console.x.com. Nothing about your token or scopes is wrong.

**Bookmarks or the home timeline say they cannot identify your account** — X's `/2/users/me` is unreliable, and login tolerates it failing. The server retries it lazily on first use and caches the result, so this usually resolves itself; if it persists, it is normally the enrollment trap above rather than a login problem.

## Notes

- **Recent search reaches back 7 days.** `x_get_thread` inherits that limit: an older conversation returns only its root post. Full-archive search (back to March 2006) needs a paid tier and `X_ENABLE_FULL_ARCHIVE=1`, and is capped at one request per second.
- **Bookmarks and the home timeline are self-only.** X does not serve anyone else's, so those tools take no user argument — the id comes from your token.
- **Rate limits are per endpoint and per credential**, not per plan: recent search allows 450 requests / 15 min app-only vs 300 with a user token. `x_get_rate_limit_status` shows the headroom X last reported.
- **Search asks for at least 10 results.** X's minimum for `max_results` is 10 (5 on user timelines), and X bills every post it returns — so a request for 3 fetches 10, returns all 10, and reports all 10 in `cost`. Trimming to 3 would waste seven paid posts and make `next_token` skip them.
- **`x_get_usage_report` counts this process only.** It is not persisted across restarts and does not know about spend from other clients.

## Develop

```bash
pnpm install
pnpm test          # vitest — every test injects fetch; nothing leaves the machine
pnpm typecheck
pnpm lint && pnpm format:check
pnpm build
```

Tests never touch the network: `createServer` accepts an injectable `fetch`, `logger` and `tokenProvider`, and `test/tools.test.ts` drives the real server through the MCP SDK's in-memory transport. The only sockets opened are two loopback listeners in `test/oauth.test.ts`, which exercise the real OAuth callback server on ports 8798 and 8799.

### Publish

```bash
pnpm dlx release-it          # tags vX.Y.Z; CI publishes to npm and GHCR
```

### Verify a release

```bash
npm view @mgcrea/mcp-x --json | jq .dist.attestations
cosign verify ghcr.io/mgcrea/mcp-x:latest \
  --certificate-identity-regexp 'https://github.com/mgcrea/mcp-x/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## License

MIT © [Olivier Louvignes](https://github.com/mgcrea)
