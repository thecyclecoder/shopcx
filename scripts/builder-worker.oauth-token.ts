/**
 * Long-lived `claude setup-token` auth for the box's Max pool accounts — the pure helpers
 * [[../scripts/builder-worker.ts]] uses to read each account's token file and decide what a
 * token account's health means. Kept in its own module (like the sibling
 * [[../scripts/builder-worker.auth-refresh.ts]]) so [[../scripts/builder-worker.oauth-token.test.ts]]
 * can import it without dragging in builder-worker.ts's top-level `main()`.
 *
 * WHY: a `/login` credential carries a ROTATING refresh token in `$CLAUDE_CONFIG_DIR/.credentials.json`.
 * Every refresh mints a new refresh token and retires the old one, and the CLI does no file locking —
 * so when the ~8h access token expires while several lanes run on the same account, the concurrent
 * refreshes race and the losers leave the account with a dead/missing refresh token
 * (anthropics/claude-code#48786). That is the root cause of the recurring `reauth_required` /
 * `refresh_failed` outages (2026-07-25, 2026-08-03, 2026-09-24→10-02). A `claude setup-token` token is
 * a one-year, inference-only subscription credential passed as `CLAUDE_CODE_OAUTH_TOKEN`; it ranks above
 * the `/login` credential and has no refresh token to race on.
 *
 * Storage: one token per account, in `<configDir>/.oauth-token` (mode 0600), written by
 * `scripts/box-install-oauth-token.sh`. The file's mtime is the mint time — the one-year expiry is
 * computed from it (the token itself carries no readable expiry).
 */
import { readFileSync, statSync } from "fs";
import { join } from "path";

export const OAUTH_TOKEN_FILENAME = ".oauth-token";
// `claude setup-token` mints a one-year token (code.claude.com/docs/en/authentication § Generate a
// long-lived token). The mint time is the token file's mtime, so this is an estimate that errs early
// (the file is written a minute or so after the mint).
export const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
// Raise the CEO renewal card a month ahead — a re-mint is a two-minute op, but it needs the founder
// at a browser, so give plenty of slack.
export const SETUP_TOKEN_WARN_MS = 30 * 24 * 60 * 60 * 1000;

export type AccountHoldReason = "usage_cap" | "auth_expired" | "refresh_failed" | "reauth_required";

export interface OauthToken {
  token: string;
  mintedAt: number; // epoch-ms — the token file's mtime
}

// Parse the token file's contents. Returns null for anything that can't be a token (empty, multi-word,
// implausibly short) so a half-pasted file never replaces a working `/login` credential.
export function parseOauthTokenFile(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (t.length < 20) return null;
  if (/\s/.test(t)) return null;
  return t;
}

// Read `<configDir>/.oauth-token`. Null when absent/unreadable/malformed — the account then keeps
// using its `/login` credentials exactly as before (the switch is per account and opt-in).
export function readOauthToken(configDir: string): OauthToken | null {
  try {
    const p = join(configDir, OAUTH_TOKEN_FILENAME);
    const token = parseOauthTokenFile(readFileSync(p, "utf8"));
    if (!token) return null;
    return { token, mintedAt: statSync(p).mtimeMs };
  } catch {
    return null;
  }
}

export type TokenExpiry =
  | { kind: "ok"; expiresAt: number; msUntilExpiry: number }
  | { kind: "expiring_soon"; expiresAt: number; msUntilExpiry: number }
  | { kind: "expired"; expiresAt: number; msUntilExpiry: number };

export function tokenExpiryStatus(mintedAt: number, now: number): TokenExpiry {
  const expiresAt = mintedAt + SETUP_TOKEN_LIFETIME_MS;
  const msUntilExpiry = expiresAt - now;
  if (msUntilExpiry <= 0) return { kind: "expired", expiresAt, msUntilExpiry };
  if (msUntilExpiry <= SETUP_TOKEN_WARN_MS) return { kind: "expiring_soon", expiresAt, msUntilExpiry };
  return { kind: "ok", expiresAt, msUntilExpiry };
}

const AUTH_HOLDS: ReadonlySet<AccountHoldReason> = new Set(["auth_expired", "refresh_failed", "reauth_required"]);

// Should a HELD account that now has a token file be released back into rotation?
//   - only AUTH holds are released (a usage wall is a usage wall whatever the credential);
//   - a hold placed while the account was ALREADY on this token (the token itself got a 401 — revoked
//     or past its year) is only released once a NEWER token file is installed, so a dead token can't
//     flap the account in and out of rotation;
//   - a hold with no recorded token mint (a `/login`-era hold, or one restored from the heartbeat after
//     a restart) is released as soon as a token is present — that's the switch-over path.
export function decideTokenHoldRelease(input: {
  holdReason: AccountHoldReason | null | undefined;
  cappedUntil: number;
  now: number;
  token: OauthToken | null;
  tokenMintedAtWhenHeld: number | null | undefined;
}): "release" | "keep" {
  if (input.cappedUntil <= input.now) return "keep"; // not held — nothing to release
  if (!input.token) return "keep";
  if (!input.holdReason || !AUTH_HOLDS.has(input.holdReason)) return "keep";
  if (input.tokenMintedAtWhenHeld != null && input.token.mintedAt <= input.tokenMintedAtWhenHeld) return "keep";
  return "release";
}

// The env a spawned `claude` gets for its account: the account's token when it has one, and NEVER an
// inherited global CLAUDE_CODE_OAUTH_TOKEN (that would silently run every account on one login).
export function applyOauthTokenEnv(env: NodeJS.ProcessEnv, token: OauthToken | null): void {
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token.token;
}
