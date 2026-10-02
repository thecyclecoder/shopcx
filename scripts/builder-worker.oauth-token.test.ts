/**
 * Unit tests for [[../scripts/builder-worker.oauth-token.ts]] — the per-account `claude setup-token`
 * auth that replaces the race-prone `/login` refresh tokens on the box's Max pool.
 *
 *   npx tsx --test scripts/builder-worker.oauth-token.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OAUTH_TOKEN_FILENAME,
  SETUP_TOKEN_LIFETIME_MS,
  SETUP_TOKEN_WARN_MS,
  applyOauthTokenEnv,
  decideTokenHoldRelease,
  parseOauthTokenFile,
  readOauthToken,
  tokenExpiryStatus,
} from "./builder-worker.oauth-token";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "sk-ant-oat01-" + "x".repeat(40);

test("parseOauthTokenFile trims a pasted token and rejects junk", () => {
  assert.equal(parseOauthTokenFile(`  ${TOKEN}\n`), TOKEN);
  assert.equal(parseOauthTokenFile(""), null);
  assert.equal(parseOauthTokenFile("short"), null);
  assert.equal(parseOauthTokenFile(`${TOKEN} ${TOKEN}`), null);
});

test("readOauthToken reads the file + uses its mtime as the mint time; absent → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "oauth-token-"));
  assert.equal(readOauthToken(dir), null);
  const p = join(dir, OAUTH_TOKEN_FILENAME);
  writeFileSync(p, TOKEN + "\n");
  const minted = new Date(NOW);
  utimesSync(p, minted, minted);
  const t = readOauthToken(dir);
  assert.ok(t);
  assert.equal(t.token, TOKEN);
  assert.equal(Math.round(t.mintedAt), NOW);
  writeFileSync(p, "garbage");
  assert.equal(readOauthToken(dir), null);
});

test("tokenExpiryStatus: ok → expiring_soon inside 30d → expired after a year", () => {
  assert.equal(tokenExpiryStatus(NOW, NOW + DAY).kind, "ok");
  assert.equal(tokenExpiryStatus(NOW, NOW + SETUP_TOKEN_LIFETIME_MS - SETUP_TOKEN_WARN_MS + DAY).kind, "expiring_soon");
  assert.equal(tokenExpiryStatus(NOW, NOW + SETUP_TOKEN_LIFETIME_MS + 1).kind, "expired");
});

test("decideTokenHoldRelease: installing a token releases a /login-era auth hold (the switch-over)", () => {
  const token = { token: TOKEN, mintedAt: NOW - DAY };
  for (const holdReason of ["reauth_required", "refresh_failed", "auth_expired"] as const) {
    assert.equal(decideTokenHoldRelease({ holdReason, cappedUntil: NOW + DAY, now: NOW, token, tokenMintedAtWhenHeld: undefined }), "release");
  }
});

test("decideTokenHoldRelease: never releases a usage cap, an unknown hold, or an account with no token", () => {
  const token = { token: TOKEN, mintedAt: NOW - DAY };
  assert.equal(decideTokenHoldRelease({ holdReason: "usage_cap", cappedUntil: NOW + DAY, now: NOW, token, tokenMintedAtWhenHeld: undefined }), "keep");
  assert.equal(decideTokenHoldRelease({ holdReason: null, cappedUntil: NOW + DAY, now: NOW, token, tokenMintedAtWhenHeld: undefined }), "keep");
  assert.equal(decideTokenHoldRelease({ holdReason: "reauth_required", cappedUntil: NOW + DAY, now: NOW, token: null, tokenMintedAtWhenHeld: undefined }), "keep");
});

test("decideTokenHoldRelease: a token that itself 401'd stays held until a NEWER token is installed", () => {
  const old = { token: TOKEN, mintedAt: NOW - 10 * DAY };
  assert.equal(decideTokenHoldRelease({ holdReason: "auth_expired", cappedUntil: NOW + DAY, now: NOW, token: old, tokenMintedAtWhenHeld: old.mintedAt }), "keep");
  const fresh = { token: TOKEN + "y", mintedAt: NOW - 60_000 };
  assert.equal(decideTokenHoldRelease({ holdReason: "auth_expired", cappedUntil: NOW + DAY, now: NOW, token: fresh, tokenMintedAtWhenHeld: old.mintedAt }), "release");
});

test("applyOauthTokenEnv sets the account's token and never leaks an inherited global one", () => {
  const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "global-should-not-leak" };
  applyOauthTokenEnv(env, null);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  applyOauthTokenEnv(env, { token: TOKEN, mintedAt: NOW });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
});
