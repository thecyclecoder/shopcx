import { createHmac, timingSafeEqual } from "crypto";

// ─── Showcase gate (password-gated investor/friend section) ──────────────────
// A self-contained, READ-ONLY narrative section under /showcase. The gate is a
// single shared password + a signed httpOnly cookie. No DB, no internal APIs,
// no secrets rendered — purely static prose. See docs/brain/lifecycles/showcase.md.

/** Documented dev fallback so the POC works with zero env config. MUST be
 *  overridden in Vercel via SHOWCASE_PASSWORD before this is shared externally. */
export const SHOWCASE_DEFAULT_PASSWORD = "superfoods";

export const SHOWCASE_COOKIE_NAME = "showcase_session";
/** 14-day session — long enough that an investor revisiting doesn't re-auth,
 *  short enough that a leaked cookie expires on its own. */
export const SHOWCASE_COOKIE_MAX_AGE = 60 * 60 * 24 * 14;

/** The shared password, read at request time (never cached at module load so a
 *  Vercel env change takes effect on the next request without a redeploy). When
 *  unset we fall back to the documented default and log a one-time warning. */
export function getShowcasePassword(): string {
  const fromEnv = process.env.SHOWCASE_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  console.warn(
    "[showcase] SHOWCASE_PASSWORD is not set — using the documented dev fallback. " +
      "Set SHOWCASE_PASSWORD in Vercel before sharing /showcase externally.",
  );
  return SHOWCASE_DEFAULT_PASSWORD;
}

/** Signing key for the session cookie. Prefer a dedicated secret; fall back to
 *  the app's ENCRYPTION_KEY, then to a derived constant so the POC never hard-
 *  errors. The cookie holds no secret — it's a signed "you knew the password"
 *  token — so the fallback is acceptable for a POC. */
function getCookieSecret(): string {
  return (
    process.env.SHOWCASE_COOKIE_SECRET ||
    process.env.ENCRYPTION_KEY ||
    "shopcx-showcase-dev-signing-key"
  );
}

function sign(payload: string): string {
  return createHmac("sha256", getCookieSecret()).update(payload).digest("hex");
}

/** Mint a signed token: `<issuedAtMs>.<hmac>`. The HMAC is over the issued-at
 *  timestamp so we can both verify integrity and enforce expiry server-side. */
export function mintShowcaseToken(now: number = Date.now()): string {
  const issuedAt = String(now);
  return `${issuedAt}.${sign(issuedAt)}`;
}

/** Constant-time verify of a token. Returns true only when the signature is
 *  valid AND the token is within the max-age window. */
export function verifyShowcaseToken(
  token: string | undefined | null,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const issuedAtRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;
  // Expiry window (also rejects implausibly future-dated tokens).
  if (now - issuedAt > SHOWCASE_COOKIE_MAX_AGE * 1000) return false;
  if (issuedAt - now > 60_000) return false;

  const expected = sign(issuedAtRaw);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Constant-time password check (avoids leaking length/prefix via timing). */
export function checkShowcasePassword(submitted: string): boolean {
  const expected = getShowcasePassword();
  const a = Buffer.from(String(submitted ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
