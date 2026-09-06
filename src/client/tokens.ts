import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { warnIfGroupReadable } from "#/config";
import type { Logger } from "#/logger";

/**
 * Bumped when the shape changes incompatibly. A file from a future or unknown
 * version is treated as absent rather than guessed at — re-running `login` is a
 * 20-second cost, while misreading a token file fails in confusing ways.
 */
export const TOKEN_FILE_VERSION = 1;

export type StoredTokens = {
  version: number;
  /** A changed client id invalidates the whole file: the tokens belong to that app. */
  clientId: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  /**
   * One generation back. X invalidates the old refresh token the instant a
   * refresh succeeds, so if we crash between receiving new tokens and writing
   * them, the on-disk token is already dead. Keeping the previous one lets a
   * failed refresh retry once instead of forcing the user through a browser.
   */
  previousRefreshToken?: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
  obtainedAt: number;
  userId?: string;
  username?: string;
};

export type TokenStore = {
  read(): StoredTokens | undefined;
  write(tokens: StoredTokens): void;
  clear(): void;
  path: string;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The on-disk token file, read once and then served from memory.
 *
 * Every API request asks the provider for a token, and the provider asks the
 * store, so without the memo that is a `readFileSync` + `statSync` per request
 * — and a "readable by other users" warning per request too. Every writer in
 * the process goes through this same object (`createServer` makes exactly
 * one), so the memo cannot go stale from inside; another process logging in
 * at the same time is the one case it misses, and re-reading on a 401 would
 * not have saved that either.
 */
export const createTokenStore = (path: string, logger?: Logger): TokenStore => {
  let cached: StoredTokens | undefined;
  let loaded = false;
  let warned = false;

  const readDisk = (): StoredTokens | undefined => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Could not read the token file (${path}): ${message(err)}`, { cause: err });
    }

    if (!warned) {
      warned = true;
      warnIfGroupReadable(path, logger);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt token file is recoverable by logging in again, so this is a
      // warning path rather than a fatal one.
      logger?.warn?.(`[x] ${path} is not valid JSON — run \`x-mcp login\` again.`);
      return undefined;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as StoredTokens).version !== TOKEN_FILE_VERSION
    ) {
      return undefined;
    }
    return parsed as StoredTokens;
  };

  return {
    path,

    read() {
      if (!loaded) {
        cached = readDisk();
        loaded = true;
      }
      return cached;
    },

    write(tokens) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Write to a temp file and rename: the rename is atomic, so a concurrent
      // reader never sees a half-written file, and the mode is 0600 from the
      // first byte rather than briefly world-readable.
      const tmp = join(dirname(path), `.tokens.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      cached = tokens;
      loaded = true;
    },

    clear() {
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      cached = undefined;
      loaded = true;
    },
  };
};

/** True when the stored tokens cannot serve the app or scopes we now need. */
export const tokensAreStale = (
  tokens: StoredTokens | undefined,
  clientId: string,
  requiredScopes: string[],
): { stale: true; reason: string } | { stale: false } => {
  if (!tokens) return { stale: true, reason: "no stored tokens" };
  if (tokens.clientId !== clientId) {
    return { stale: true, reason: "the stored tokens belong to a different X_CLIENT_ID" };
  }
  const missing = requiredScopes.filter((scope) => !tokens.scopes.includes(scope));
  if (missing.length > 0) {
    // Better to say so now than to let X answer 403 for a reason the user
    // cannot see from the error.
    return { stale: true, reason: `the stored tokens lack the scope(s): ${missing.join(", ")}` };
  }
  return { stale: false };
};

/** Mode bits of the token file, for tests and `x_get_auth_status`. */
export const fileMode = (path: string): number | undefined => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
};
