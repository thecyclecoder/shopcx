// Shopify Multipass token generation (Plus accounts only)
// See: https://shopify.dev/docs/api/multipass

import crypto from "crypto";

export function generateMultipassToken(
  multipassSecret: string,
  customerData: { email: string; return_to: string; created_at?: string },
): string {
  const keyMaterial = crypto.createHash("sha256").update(multipassSecret).digest();
  const encryptionKey = keyMaterial.subarray(0, 16);
  const signingKey = keyMaterial.subarray(16, 32);

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  const json = JSON.stringify({
    ...customerData,
    created_at: customerData.created_at || new Date().toISOString(),
  });
  const encrypted = Buffer.concat([iv, cipher.update(json, "utf8"), cipher.final()]);

  const signature = crypto.createHmac("sha256", signingKey).update(encrypted).digest();

  return Buffer.concat([encrypted, signature]).toString("base64url");
}

export function generateMultipassUrl(
  shop: string,
  multipassSecret: string,
  email: string,
  returnTo: string,
): string {
  const token = generateMultipassToken(multipassSecret, { email, return_to: returnTo });
  return `https://${shop}/account/login/multipass/${token}`;
}
