/**
 * Magic Link system for portal login.
 * Generates signed, time-limited tokens that auto-log customers into the portal.
 * Replaces Shopify Multipass (which doesn't work with new customer accounts).
 */

import crypto from "crypto";

const SECRET = process.env.ENCRYPTION_KEY || "";
const EXPIRY_HOURS = 24;

interface MagicLinkPayload {
  customerId: string;
  shopifyCustomerId: string;
  email: string;
  workspaceId: string;
  exp: number;
}

/**
 * Generate a magic link token for a customer.
 * Token is a signed, base64url-encoded JSON payload.
 */
export function generateMagicToken(
  customerId: string,
  shopifyCustomerId: string,
  email: string,
  workspaceId: string,
): string {
  const payload: MagicLinkPayload = {
    customerId,
    shopifyCustomerId,
    email,
    workspaceId,
    exp: Date.now() + EXPIRY_HOURS * 60 * 60 * 1000,
  };

  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * Verify and decode a magic link token.
 * Returns the payload if valid, null if expired or tampered.
 */
export function verifyMagicToken(token: string): MagicLinkPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [data, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

  if (sig !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as MagicLinkPayload;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a full magic link URL for a customer.
 */
export function generateMagicLinkURL(
  customerId: string,
  shopifyCustomerId: string,
  email: string,
  workspaceId: string,
): string {
  const token = generateMagicToken(customerId, shopifyCustomerId, email, workspaceId);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  return `${base}/portal/login?token=${token}`;
}
