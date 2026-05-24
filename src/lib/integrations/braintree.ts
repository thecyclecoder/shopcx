/**
 * Per-workspace Braintree gateway access.
 *
 * Credentials live on the workspaces row (4 columns added in
 * 20260519200000_workspaces_braintree.sql). The private key is
 * AES-256-GCM encrypted; everything else is plaintext.
 *
 *   getBraintreeGateway(workspaceId)     Resolve a ready-to-use BraintreeGateway.
 *   verifyBraintreeCredentials(...)      Smoke-test creds before saving.
 *
 * Gateway instances are cached per-workspace for 5 minutes — the
 * Braintree SDK keeps a connection pool internally so reusing the
 * same gateway is cheaper than reconstructing it on every request.
 */

import braintree from "braintree";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

interface CachedGateway {
  gateway: braintree.BraintreeGateway;
  merchantId: string;
  environment: "production" | "sandbox";
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedGateway>();

export interface BraintreeConfig {
  merchant_id: string;
  public_key: string;
  private_key: string;
  environment: "production" | "sandbox";
}

function buildGateway(c: BraintreeConfig): braintree.BraintreeGateway {
  return new braintree.BraintreeGateway({
    environment:
      c.environment === "sandbox"
        ? braintree.Environment.Sandbox
        : braintree.Environment.Production,
    merchantId: c.merchant_id,
    publicKey: c.public_key,
    privateKey: c.private_key,
  });
}

/**
 * Load a workspace's Braintree credentials. Throws if any required
 * field is missing — checkout / billing code should call this and
 * surface the error rather than silently succeeding.
 */
export async function loadBraintreeConfig(workspaceId: string): Promise<BraintreeConfig> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspaces")
    .select(
      "braintree_merchant_id, braintree_public_key, braintree_private_key_encrypted, braintree_environment",
    )
    .eq("id", workspaceId)
    .single();
  if (error || !data) {
    throw new Error(`Braintree config: workspace ${workspaceId} not found`);
  }
  if (
    !data.braintree_merchant_id ||
    !data.braintree_public_key ||
    !data.braintree_private_key_encrypted
  ) {
    throw new Error(`Braintree not configured for workspace ${workspaceId}`);
  }
  return {
    merchant_id: data.braintree_merchant_id as string,
    public_key: data.braintree_public_key as string,
    private_key: decrypt(data.braintree_private_key_encrypted as string),
    environment: (data.braintree_environment as "production" | "sandbox") || "production",
  };
}

/**
 * Resolve a ready-to-use BraintreeGateway for the workspace. Cached
 * for 5 minutes. Throws if creds aren't configured (see
 * loadBraintreeConfig).
 */
export async function getBraintreeGateway(workspaceId: string): Promise<braintree.BraintreeGateway> {
  const cached = cache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.gateway;

  const config = await loadBraintreeConfig(workspaceId);
  const gateway = buildGateway(config);
  cache.set(workspaceId, {
    gateway,
    merchantId: config.merchant_id,
    environment: config.environment,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return gateway;
}

/** Invalidate the cache (call after a credential save). */
export function invalidateBraintreeCache(workspaceId: string): void {
  cache.delete(workspaceId);
}

/**
 * Refund a settled Braintree transaction directly via the Braintree API.
 *
 * Use this when Shopify's native gateway refund is unavailable — e.g. the
 * Shopify↔Braintree payment-gateway connection was removed, so Shopify
 * refunds fail with "undefined method 'refund' for nil" / ID_NOT_FOUND
 * (seen on order SC128233, 2026-04). The Braintree transaction itself is
 * still fully refundable; we just have to call Braintree directly.
 *
 * `transactionId` is the Braintree transaction id — Shopify stores it as
 * `transaction.authorization` on the sale transaction.
 *
 * Status handling:
 *  - settled / settling → partial or full refund (omit amountCents for full).
 *  - submitted_for_settlement / authorized → NOT refundable yet; the only
 *    reversal is a full `void`, so we surface a clear error instead of
 *    silently voiding (which a partial-refund caller never wants).
 */
export async function refundBraintreeTransaction(
  workspaceId: string,
  transactionId: string,
  amountCents?: number,
): Promise<{ success: boolean; refundId?: string; error?: string }> {
  try {
    const gateway = await getBraintreeGateway(workspaceId);
    const txn = await gateway.transaction.find(transactionId).catch(() => null);
    if (!txn) return { success: false, error: `Braintree transaction ${transactionId} not found` };

    if (txn.status === "submitted_for_settlement" || txn.status === "authorized") {
      return {
        success: false,
        error: `Braintree transaction ${transactionId} is ${txn.status}, not settled — a partial refund isn't possible until it settles. Void the full transaction instead, or retry once settled.`,
      };
    }
    if (txn.status !== "settled" && txn.status !== "settling") {
      return { success: false, error: `Braintree transaction ${transactionId} status is ${txn.status} — not refundable.` };
    }

    const amount = amountCents != null ? (amountCents / 100).toFixed(2) : undefined;
    const result = amount
      ? await gateway.transaction.refund(transactionId, amount)
      : await gateway.transaction.refund(transactionId);

    if (!result.success) {
      return { success: false, error: result.message || "Braintree refund was rejected" };
    }
    return { success: true, refundId: result.transaction?.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verify credentials by calling a cheap, read-only Braintree endpoint.
 * We use clientToken.generate — it's free, returns fast, and any
 * auth/merchant misconfiguration surfaces as an error.
 */
export async function verifyBraintreeCredentials(
  config: BraintreeConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const gateway = buildGateway(config);
    const result = await gateway.clientToken.generate({});
    if (!result.success) {
      return { ok: false, error: result.message || "Braintree rejected the credentials" };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
