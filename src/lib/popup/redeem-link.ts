/**
 * Cross-device popup-coupon redeem link (storefront-mvp Phase 4f).
 *
 * The coupon is delivered by SMS/email, often opened on a DIFFERENT device than
 * the one that browsed the PDP — so the `popup_coupon` cookie set at claim time
 * doesn't carry over. This link closes that gap: a signed token encodes the
 * customer + code + product handle, and /api/popup/land verifies it, sets the
 * identity + coupon cookies on the storefront domain, and drops the visitor back
 * on the exact PDP with the discount auto-applied (reflected in the price tables
 * and stamped on whatever cart they create).
 */
import crypto from "crypto";

const SECRET = process.env.ENCRYPTION_KEY || "";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the coupon's shelf life

export interface PopupLinkPayload {
  c: string; // customer id (the code's owner)
  code: string; // the derived coupon code (WELCOME-GSXN)
  h: string; // product handle to land on
  ws: string; // workspace id
  exp: number;
}

export function signPopupLink(p: Omit<PopupLinkPayload, "exp">, ttlMs: number = DEFAULT_TTL_MS): string {
  const payload: PopupLinkPayload = { ...p, exp: Date.now() + ttlMs };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyPopupLink(token: string): PopupLinkPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as PopupLinkPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Build the full redeem URL on the workspace's storefront domain. Falls back to
 * the shopcx.ai admin-preview path when no custom storefront domain is set.
 */
export async function buildPopupRedeemUrl(
  workspaceId: string,
  customerId: string,
  code: string,
  handle: string,
): Promise<string> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("storefront_domain, storefront_slug")
    .eq("id", workspaceId)
    .maybeSingle();
  const token = signPopupLink({ c: customerId, code, h: handle, ws: workspaceId });
  const domain = (ws?.storefront_domain as string | null) || null;
  if (domain) {
    return `https://${domain}/api/popup/land?t=${encodeURIComponent(token)}`;
  }
  // Admin-preview fallback — the land route redirects under /store/{slug}/{handle}.
  return `https://shopcx.ai/api/popup/land?t=${encodeURIComponent(token)}`;
}

/**
 * Same as buildPopupRedeemUrl, but shortened to a sprfd.co/AB12CD link so SMS
 * stays under the 160-char single-segment limit. Falls back to the full URL
 * when the workspace has no shortlink domain (or shortening fails).
 */
export async function buildPopupRedeemShortUrl(
  workspaceId: string,
  customerId: string,
  code: string,
  handle: string,
): Promise<string> {
  const longUrl = await buildPopupRedeemUrl(workspaceId, customerId, code, handle);
  try {
    const { createShortlink } = await import("@/lib/shortlink-create");
    // 7-day shelf life, matching the coupon link's TTL.
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
    const short = await createShortlink(workspaceId, longUrl, { expiresAt });
    if (short) return short;
  } catch {
    /* fall back to the long URL */
  }
  return longUrl;
}
