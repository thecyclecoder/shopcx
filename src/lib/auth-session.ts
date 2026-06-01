/**
 * Signed `sx_session` cookie for the storefront customer session.
 *
 * Set after a successful OTP verify (or magic-link click). Used by:
 *   • /api/checkout/client-token to bind the Braintree drop-in to
 *     the customer's vaulted cards
 *   • /api/checkout/* to autofill addresses + recognize the customer
 *   • the portal at /portal/* to skip the login step
 *
 * Cookie format: `<base64url(payload)>.<hmacSha256(payload, secret)>`
 *   payload = { w: workspace_id, c: customer_id, exp: unix-seconds }
 *
 * Lifetime: 7 days. Cookie attributes: HttpOnly, Secure (in prod),
 * SameSite=Lax, Path=/.
 */
import crypto from "crypto";
import { cookies } from "next/headers";
import type { NextResponse, NextRequest } from "next/server";

export const SX_SESSION_COOKIE = "sx_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SessionPayload {
  w: string;    // workspace_id
  c: string;    // customer_id
  exp: number;  // unix seconds
}

function getSecret(): string {
  const s = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  if (!s) throw new Error("SESSION_SECRET or ENCRYPTION_KEY required for signing sx_session");
  return s;
}

function base64UrlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sign(payloadB64: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildSessionToken(workspaceId: string, customerId: string): string {
  const payload: SessionPayload = {
    w: workspaceId,
    c: customerId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64, getSecret());
  return `${payloadB64}.${sig}`;
}

export function verifySessionToken(token: string | null | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payloadB64, getSecret());
  // Constant-time compare to defeat timing side-channels.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload?.exp || payload.exp * 1000 < Date.now()) return null;
  if (!payload.w || !payload.c) return null;
  return payload;
}

/**
 * Set the cookie on a NextResponse — used by the API handlers that
 * complete an OTP verify or magic-link click.
 */
export function setSessionCookie(res: NextResponse, workspaceId: string, customerId: string): void {
  const token = buildSessionToken(workspaceId, customerId);
  res.cookies.set(SX_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/**
 * Read + verify the current request's session. Returns null when
 * not present, signature invalid, or expired.
 */
export async function readSessionFromCookies(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SX_SESSION_COOKIE)?.value;
  return verifySessionToken(token);
}

export function readSessionFromRequest(req: NextRequest): SessionPayload | null {
  const token = req.cookies.get(SX_SESSION_COOKIE)?.value;
  return verifySessionToken(token);
}
