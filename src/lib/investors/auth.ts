import { createHmac, timingSafeEqual } from "crypto";
import { generateMagicToken, verifyMagicToken } from "@/lib/magic-link";

// ─── Investors gate (magic-link-gated financial section) ─────────────────────
// A self-contained, READ-ONLY investor area under /investors that renders the
// exact CFO Financials charts. Structurally mirrors the /showcase gate
// (src/lib/showcase/auth.ts) but swaps the shared password for a per-person
// MAGIC LINK: the monthly email/SMS carries a signed one-time token; visiting
// /investors/enter?token=… verifies it, confirms the customer is an investor|owner,
// and mints a signed httpOnly `investors_session` cookie. See
// docs/brain/lifecycles/investors-area.md.

/** The comp roles allowed into the investors area. Matches the `comp_role`
 *  Postgres enum (employee|influencer|investor|owner) — only these two see it. */
export const INVESTOR_COMP_ROLES = ["investor", "owner"] as const;
export type InvestorCompRole = (typeof INVESTOR_COMP_ROLES)[number];

export function isInvestorRole(role: string | null | undefined): role is InvestorCompRole {
  return role === "investor" || role === "owner";
}

export const INVESTORS_COOKIE_NAME = "investors_session";
/** 30-day session — an investor who clicked this month's link stays in until
 *  well past the next monthly send, so a revisit never dead-ends. */
export const INVESTORS_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** The emailed magic link is valid for 40 days — comfortably past the next
 *  monthly (20th) send, so last month's link still works if this month's is late. */
export const INVESTOR_MAGIC_EXPIRY_HOURS = 24 * 40;

function getCookieSecret(): string {
  return process.env.ENCRYPTION_KEY || "shopcx-investors-dev-signing-key";
}

function sign(payload: string): string {
  return createHmac("sha256", getCookieSecret()).update(payload).digest("hex");
}

/** Mint the session cookie value: `<customerId>.<issuedAtMs>.<hmac>`. Carries the
 *  viewer's customer id (so the page can greet them / scope data) and is signed +
 *  time-boxed so the proxy can gate every /investors/* request with no DB hit. */
export function mintInvestorSession(customerId: string, now: number = Date.now()): string {
  const body = `${customerId}.${now}`;
  return `${body}.${sign(body)}`;
}

/** Verify + decode a session cookie. Returns `{ customerId }` when the signature
 *  is valid AND within the max-age window, else null. Constant-time on the HMAC. */
export function verifyInvestorSession(
  token: string | undefined | null,
  now: number = Date.now(),
): { customerId: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [customerId, issuedAtRaw, sig] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!customerId || !Number.isFinite(issuedAt)) return null;
  if (now - issuedAt > INVESTORS_COOKIE_MAX_AGE * 1000) return null;
  if (issuedAt - now > 60_000) return null;
  const expected = sign(`${customerId}.${issuedAtRaw}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    return timingSafeEqual(a, b) ? { customerId } : null;
  } catch {
    return null;
  }
}

/** Build a full magic-link URL that drops an investor straight into /investors.
 *  Reuses the app's signed magic-token (src/lib/magic-link.ts) — the /investors/enter
 *  route verifies it, so we don't need a bespoke token format. */
export function generateInvestorMagicLink(
  customerId: string,
  email: string,
  workspaceId: string,
): string {
  const token = generateMagicToken(customerId, "", email, workspaceId, INVESTOR_MAGIC_EXPIRY_HOURS);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  return `${base}/investors/enter?token=${token}`;
}

/** Re-export so the entry route + tests import token verification from one place. */
export { verifyMagicToken };
