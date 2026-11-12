import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

/**
 * Verified identity pass for the chat widget (see docs/brain/libraries/widget-identity.md).
 *
 * In ShopGrowth's embedded Shopify admin app the person chatting is staff of a specific store and
 * only ShopGrowth can prove which (Shopify session token). The widget must not trust a typed email.
 * ShopGrowth mints a short-lived HMAC-SHA256 pass, signed with the workspace's shared secret, and
 * the widget API verifies it before keying the contact to the store.
 *
 * Token format: `v1.<base64url(payloadJSON)>.<base64url(sig)>`
 *   - payloadJSON = JSON of { shop, app, email, name?, exp }
 *       shop  — the merchant's myshopify domain (e.g. "acme.myshopify.com")
 *       app   — the ShopGrowth app slug the staff member is chatting from
 *       email — the staff member's email (the contact key)
 *       name  — optional display name
 *       exp   — expiry, epoch SECONDS; must be in the future and ≤ 15 min ahead
 *   - sig = HMAC-SHA256(secret, "v1.<base64url(payloadJSON)>")
 *
 * The signing side lives in ShopGrowth, which holds the SAME per-workspace secret via its env; this
 * file is the verify side. `signWidgetIdentityToken` is exported so the test (and ShopGrowth's docs)
 * can exercise the exact format — production signing happens in ShopGrowth, not here.
 */

export interface WidgetIdentityPayload {
  shop: string;
  app: string;
  email: string;
  name?: string;
  exp: number; // epoch seconds
}

export interface VerifiedWidgetIdentity {
  shop: string;
  app: string;
  email: string;
  name: string | null;
}

/** A pass is valid only if its expiry is in the future and no further than this ahead. */
export const MAX_IDENTITY_EXP_SKEW_MS = 15 * 60 * 1000;

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(secret: string, signingInput: string): string {
  return b64urlEncode(createHmac("sha256", secret).update(signingInput).digest());
}

/**
 * Mint a pass. Exported for tests + ShopGrowth parity documentation — the real signer is ShopGrowth.
 * `exp` is epoch seconds.
 */
export function signWidgetIdentityToken(secret: string, payload: WidgetIdentityPayload): string {
  const b64payload = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signingInput = `v1.${b64payload}`;
  return `${signingInput}.${sign(secret, signingInput)}`;
}

/**
 * Pure verify: validate a token against a known secret. Returns the verified identity, or null if
 * the token is malformed, the signature does not match (constant-time compare), or the expiry is
 * past / more than 15 min ahead. `nowMs` is injectable for deterministic tests.
 */
export function verifyWidgetIdentityToken(
  secret: string,
  token: string | null | undefined,
  nowMs: number = Date.now()
): VerifiedWidgetIdentity | null {
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, b64payload, b64sig] = parts;
  if (version !== "v1" || !b64payload || !b64sig) return null;

  // Constant-time signature compare. timingSafeEqual throws on length mismatch, so guard first.
  const expectedSig = Buffer.from(sign(secret, `v1.${b64payload}`), "utf8");
  const gotSig = Buffer.from(b64sig, "utf8");
  if (expectedSig.length !== gotSig.length) return null;
  if (!timingSafeEqual(expectedSig, gotSig)) return null;

  let payload: WidgetIdentityPayload;
  try {
    payload = JSON.parse(b64urlDecode(b64payload).toString("utf8"));
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload.shop !== "string" || !payload.shop ||
    typeof payload.app !== "string" || !payload.app ||
    typeof payload.email !== "string" || !payload.email ||
    typeof payload.exp !== "number" || !Number.isFinite(payload.exp)
  ) {
    return null;
  }
  if (payload.name !== undefined && typeof payload.name !== "string") return null;

  const expMs = payload.exp * 1000;
  if (expMs < nowMs) return null; // expired
  if (expMs > nowMs + MAX_IDENTITY_EXP_SKEW_MS) return null; // too far ahead — reject unbounded passes

  return {
    shop: payload.shop,
    app: payload.app,
    email: payload.email.toLowerCase().trim(),
    name: payload.name ?? null,
  };
}

/**
 * Verify a widget identity pass for a workspace. Reads the per-workspace secret from
 * `workspaces.widget_identity_secret_encrypted` (decrypted via src/lib/crypto.ts) and delegates to
 * the pure verifier. Returns null when the workspace has no secret configured, the read fails, or
 * the token is invalid/expired — the caller decides whether a null pass is fatal (software mode) or
 * merely optional (cpg mode).
 */
export async function verifyWidgetIdentity(
  workspaceId: string,
  token: string | null | undefined
): Promise<VerifiedWidgetIdentity | null> {
  if (!workspaceId || !token) return null;

  let secret: string;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("workspaces")
      .select("widget_identity_secret_encrypted")
      .eq("id", workspaceId)
      .maybeSingle();
    if (error || !data?.widget_identity_secret_encrypted) return null;
    secret = decrypt(data.widget_identity_secret_encrypted);
  } catch {
    return null;
  }

  return verifyWidgetIdentityToken(secret, token);
}

/** The verified store tags stamped on the customer + ticket so orchestrator tools read shop/app
 * from proven data, never a typed value. */
export function identityTags(pass: VerifiedWidgetIdentity): string[] {
  return [`shop:${pass.shop}`, `app:${pass.app}`];
}
