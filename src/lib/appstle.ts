import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { loggedAppstleFetch } from "@/lib/appstle-call-log";
import { healOnTouch } from "@/lib/appstle-pricing";
import {
  isInternalSubscription,
  internalSubscriptionAction,
  internalSubSkipNextOrder,
  internalSubUpdateBillingInterval,
  internalSubUpdateNextBillingDate,
  internalSubNotYetSupported,
  advanceDate,
} from "@/lib/internal-subscription";

async function getAppstleCredentials(workspaceId: string): Promise<{ apiKey: string; shop: string } | null> {
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("appstle_api_key_encrypted, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.appstle_api_key_encrypted || !workspace?.shopify_myshopify_domain) {
    return null;
  }

  return {
    apiKey: decrypt(workspace.appstle_api_key_encrypted),
    shop: workspace.shopify_myshopify_domain,
  };
}

export async function appstleSubscriptionAction(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
  cancelReason?: string,
  cancelledBy?: string,
): Promise<{ success: boolean; error?: string }> {
  // Internal subscriptions never touch Appstle — DB updates only.
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubscriptionAction(workspaceId, contractId, action);
  }

  // Heal-on-touch (skip on cancel — no point structuring a sub we're killing).
  if (action !== "cancel") await healOnTouch(workspaceId, contractId);

  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    let res: Response;

    if (action === "cancel") {
      // Use DELETE endpoint with cancellationFeedback for proper reason tracking
      const params = new URLSearchParams();
      if (cancelReason) params.set("cancellationFeedback", cancelReason);
      const byLine = cancelledBy ? `by ${cancelledBy} on ShopCX.ai` : "via ShopCX.ai";
      params.set("cancellationNote", `Cancelled ${byLine} — ${cancelReason || "manual"}`);
      const endpoint = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/${contractId}?${params}`;
      res = await loggedAppstleFetch(endpoint, {
        method: "DELETE",
        headers: { "X-API-Key": creds.apiKey },
      });
    } else {
      // Pause / Resume use the update-status PUT endpoint
      const statusMap: Record<string, string> = { pause: "PAUSED", resume: "ACTIVE" };
      const endpoint = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=${statusMap[action]}`;
      res = await loggedAppstleFetch(endpoint, {
        method: "PUT",
        headers: { "X-API-Key": creds.apiKey },
      });
    }

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle ${action} error for contract ${contractId}:`, text);
      // Surface the Appstle response body so the portal healer's
      // classifyPortalFailure() can recognize transient 400s (e.g. "billing
      // operation is already in progress" right after a renewal bills) and
      // auto-retry instead of escalating. Mirrors appstleSkipUpcomingOrder.
      return { success: false, error: text || `Appstle API error: ${res.status}` };
    }

    // Update local subscription status
    const admin = createAdminClient();
    const localStatusMap: Record<string, string> = { pause: "paused", cancel: "cancelled", resume: "active" };
    const { data: sub } = await admin
      .from("subscriptions")
      .update({ status: localStatusMap[action], updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .select("customer_id")
      .single();

    // Keep customers.subscription_status in sync — use highest priority across all subs
    if (sub?.customer_id) {
      const { data: allSubs } = await admin
        .from("subscriptions")
        .select("status")
        .eq("customer_id", sub.customer_id);
      const statuses = new Set((allSubs || []).map(s => s.status));
      const customerStatus = statuses.has("active") ? "active"
        : statuses.has("paused") ? "paused"
        : statuses.has("cancelled") ? "cancelled"
        : "never";
      await admin.from("customers").update({
        subscription_status: customerStatus,
        updated_at: new Date().toISOString(),
      }).eq("id", sub.customer_id);
    }

    return { success: true };
  } catch (err) {
    console.error(`Appstle ${action} failed:`, err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSkipNextOrder(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; error?: string }> {
  // A "skip" = push the next order out by one billing cycle. We implement
  // it as a change-next-billing-date rather than Appstle's dedicated skip
  // endpoint (subscription-contracts-skip), which returns 405 / is unreliable
  // (see project_appstle_disabled_features). Advancing the date is functionally
  // equivalent and uses the working reschedule endpoint — same behavior for
  // internal subs (internalSubUpdateNextBillingDate just sets the date).
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubSkipNextOrder(workspaceId, contractId);
  }

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("next_billing_date, billing_interval, billing_interval_count")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (!sub) return { success: false, error: "Subscription not found" };

  const interval = (sub.billing_interval || "month").toLowerCase();
  const count = sub.billing_interval_count || 1;
  const base = sub.next_billing_date ? new Date(sub.next_billing_date) : new Date();
  const next = advanceDate(base, interval, count);

  // Reschedule via the working change-date endpoint.
  const result = await appstleUpdateNextBillingDate(workspaceId, contractId, next.toISOString());
  if (!result.success) return result;

  // Mirror the new date locally (the Appstle reschedule endpoint doesn't write
  // our table; keep the portal/next-billing views accurate until the next sync).
  await admin
    .from("subscriptions")
    .update({ next_billing_date: next.toISOString(), updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId);

  return { success: true };
}

export async function appstleUpdateBillingInterval(
  workspaceId: string,
  contractId: string,
  interval: "DAY" | "WEEK" | "MONTH" | "YEAR",
  intervalCount: number,
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubUpdateBillingInterval(workspaceId, contractId, interval, intervalCount);
  }

  // Appstle's SellingPlanInterval enum is strictly UPPERCASE
  // (DAY/WEEK/MONTH/YEAR). The TS signature claims uppercase but the
  // value can come from Opus as lowercase ("week", "month") — that
  // hits a 400 from Appstle ("No enum constant ... .week"). Force-
  // uppercase before the call. Jim O'Brien 2026-05-19 (ticket
  // 5e7c1c80) was escalated because of this.
  const normalizedInterval = String(interval).toUpperCase() as "DAY" | "WEEK" | "MONTH" | "YEAR";
  if (!["DAY", "WEEK", "MONTH", "YEAR"].includes(normalizedInterval)) {
    return { success: false, error: `Invalid interval: ${interval} (expected DAY/WEEK/MONTH/YEAR)` };
  }

  // No-op guard: skip the Appstle PUT if the local subscription already
  // has the requested interval+count. Same-value submissions hit
  // Appstle's billing-policy validator and surfaced as recurring noise
  // on the Vercel error feed / Control Tower (signature 09366492567e0fde).
  // Customer intent is satisfied; report success without the API call.
  const admin = createAdminClient();
  const { data: currentSub } = await admin
    .from("subscriptions")
    .select("billing_interval, billing_interval_count")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (
    currentSub &&
    String(currentSub.billing_interval || "").toUpperCase() === normalizedInterval &&
    Number(currentSub.billing_interval_count) === Number(intervalCount)
  ) {
    return { success: true };
  }

  await healOnTouch(workspaceId, contractId);
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-interval?contractId=${contractId}&interval=${normalizedInterval}&intervalCount=${intervalCount}&api_key=${creds.apiKey}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (res.status === 504) {
      // Appstle sometimes times out but still applies the change — verify
      const verified = await verifyBillingInterval(creds.apiKey, contractId, normalizedInterval, intervalCount);
      if (!verified) return { success: false, error: "Request timed out and change could not be verified" };
      // Fall through to update local DB
    } else if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle frequency update error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    // Update local record
    await admin
      .from("subscriptions")
      .update({
        billing_interval: normalizedInterval.toLowerCase(),
        billing_interval_count: intervalCount,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId);

    return { success: true };
  } catch (err) {
    console.error("Appstle frequency update failed:", err);
    // Appstle sometimes accepts the change but the response never arrives
    // within the loggedAppstleFetch 20s deadline — the abort surfaces here
    // as Error('upstream_timeout'). Same recovery as the res.status === 504
    // branch above: verify the contract, and if the interval matches, treat
    // the timeout as a successful apply. This closes the "false failure"
    // path signature vercel:c0c26aa990d22744 was catching.
    if (err instanceof Error && err.message === "upstream_timeout") {
      const verified = await verifyBillingInterval(creds.apiKey, contractId, normalizedInterval, intervalCount);
      if (!verified) {
        return { success: false, error: "Request timed out and change could not be verified" };
      }
      await admin
        .from("subscriptions")
        .update({
          billing_interval: normalizedInterval.toLowerCase(),
          billing_interval_count: intervalCount,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId);
      return { success: true };
    }
    return { success: false, error: String(err) };
  }
}

async function verifyBillingInterval(
  apiKey: string, contractId: string, expectedInterval: string, expectedCount: number,
): Promise<boolean> {
  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
      { headers: { "X-API-Key": apiKey } }
    );
    if (!res.ok) return false;
    const data = await res.json();
    const bp = data.billingPolicy;
    return bp?.interval?.toUpperCase() === expectedInterval.toUpperCase()
      && bp?.intervalCount === expectedCount;
  } catch {
    return false;
  }
}

export async function appstleUpdateNextBillingDate(
  workspaceId: string,
  contractId: string,
  nextBillingDate: string, // YYYY-MM-DD or full ISO datetime
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
  }
  await healOnTouch(workspaceId, contractId);
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  // Appstle expects ZonedDateTime (e.g. 2026-07-30T00:00:00Z). Date-only
  // YYYY-MM-DD strings get rejected with a Java parse error. Normalize.
  const isoDateTime = /^\d{4}-\d{2}-\d{2}$/.test(nextBillingDate)
    ? `${nextBillingDate}T00:00:00Z`
    : nextBillingDate;

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(isoDateTime)}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey }, cache: "no-store" },
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle next billing date update error for contract ${contractId}:`, text);
      const snippet = text.slice(0, 300).replace(/\s+/g, " ").trim();
      return { success: false, error: `Appstle ${res.status}: ${snippet}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle next billing date update failed:", err);
    return { success: false, error: String(err) };
  }
}

// ── Dunning endpoints ──

export async function appstleGetUpcomingOrders(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; orders?: { id: string; billingDate: string; status: string }[]; error?: string }> {
  // Internal subs don't have a separate upcoming-orders ledger;
  // next_billing_date on the subscription row IS the upcoming order.
  // Synthesize a single-item list so the existing UI works unchanged.
  if (await isInternalSubscription(workspaceId, contractId)) {
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("next_billing_date, status")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (!sub?.next_billing_date) return { success: true, orders: [] };
    return {
      success: true,
      orders: [{ id: `internal-${contractId}`, billingDate: sub.next_billing_date, status: sub.status || "active" }],
    };
  }
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/top-orders?contractId=${contractId}`,
      { method: "GET", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`Appstle get upcoming orders error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    const data = await res.json();
    // Appstle returns each order `id` as a JSON number, but our type signature
    // and every downstream caller (dunning, portal order-now, appstleAttemptBilling
    // .startsWith guard) treats it as a string. Coerce at the read boundary so
    // every caller sees a consistent string id (signature vercel:c16ba1c31f84151b).
    type RawOrder = { id: string | number; billingDate: string; status: string };
    const orders = Array.isArray(data)
      ? (data as RawOrder[]).map((o) => ({
          id: String(o.id),
          billingDate: o.billingDate,
          status: o.status,
        }))
      : [];
    return { success: true, orders };
  } catch (err) {
    console.error("Appstle get upcoming orders failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleAttemptBilling(
  workspaceId: string,
  billingAttemptId: string,
): Promise<{ success: boolean; error?: string }> {
  // Appstle's top-orders endpoint returns `id` as a JSON number, but our TS
  // signature and the internal-* synthesized ids are strings. Coerce once at
  // the boundary so the .startsWith() guard, log message, and URL interpolation
  // are all type-safe regardless of upstream shape (signature vercel:c16ba1c31f84151b).
  const id = String(billingAttemptId);
  // Internal subs (Braintree-billed) never have an Appstle billing attempt — the
  // upstream callers stamp a synthetic `internal-*` id into the cycle. Hitting
  // Appstle with that id 400s and noises the error feed. Short-circuit cleanly
  // (signature vercel:cdfbac68e30a91f9) so callers see a success while the real
  // renewal is driven by the internal daily renewal cron.
  if (id.startsWith("internal-")) {
    console.warn(`[appstleAttemptBilling] skipped internal billing-attempt id ${id} — Braintree-billed sub, no Appstle attempt to charge`);
    return { success: true };
  }
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/attempt-billing/${id}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      // The "Another billing operation is already in progress" body is a
      // concurrency lock — Appstle is ALREADY billing this contract, so the
      // customer's intent (renew now) is satisfied. order-now treats it as
      // success; log at warn so the Vercel error feed / Control Tower stop
      // capturing the benign race. See [[portal-order-now-billing-collision]].
      if (/billing operation is already in progress/i.test(text)) {
        console.warn(`Appstle attempt billing race for ${id} (concurrent charge already running):`, text);
      } else if (/usergeneratederror/i.test(text) && /out of stock/i.test(text)) {
        // Appstle UserGeneratedError = business-condition rejection from
        // upstream (here: a line item is out of stock), not a server fault.
        // Dunning rotation will pick this up via the existing return shape
        // below; log at warn so it stops noising the Vercel error feed /
        // Control Tower as a foreign-app error.
        console.warn(`Appstle attempt billing benign upstream rejection for ${id} (out of stock):`, text);
      } else {
        console.error(`Appstle attempt billing error for ${id}:`, text);
      }
      // Surface raw upstream text so the handler can pattern-match (mirrors the
      // appstleSkipUpcomingOrder shape).
      return { success: false, error: text || `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle attempt billing failed:", err);
    return { success: false, error: String(err) };
  }
}

/**
 * Flavor-aware "order now" (a.k.a. bill_now) for a sub identified by contract id.
 *
 * Internal (Braintree) subs: fire the SAME renewal pipeline a scheduled charge
 * uses (`internal-subscription/renewal-attempt`) — charge → order → Avalara →
 * Amplifier → advance next_billing_date. Async via Inngest, so this returns
 * immediately and the order lands shortly. Mirrors the portal order-now handler
 * ([[portal/handlers/order-now]]).
 *
 * Appstle subs: attempt the upcoming Appstle billing (get-upcoming → attempt).
 *
 * WHY this exists: `appstleAttemptBilling` short-circuits a synthetic `internal-*`
 * billing-attempt id to a NO-OP success (the dunning path drives the real internal
 * renewal via its own cron). On-demand order-now has no such cron follow-up, so a
 * caller that hits appstleGetUpcomingOrders + appstleAttemptBilling directly on an
 * internal sub silently drops the charge — the bug that left an internal sub
 * "order now" reporting success while never charging. EVERY immediate order-now
 * entry point (ticket-UI bill-now route, AI action-executor bill_now /
 * change_next_date ASAP fallback) MUST funnel through here.
 */
export async function orderNowByContract(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; error?: string; summary?: string; internal?: boolean }> {
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, is_internal, status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (!sub) return { success: false, error: "subscription_not_found" };

  // Internal sub: fire the real Braintree renewal pipeline.
  if (sub.is_internal) {
    if (sub.status !== "active") {
      return { success: false, error: `not_active (${sub.status})` };
    }
    const { inngest } = await import("@/lib/inngest/client");
    await inngest.send({
      name: "internal-subscription/renewal-attempt",
      data: { subscription_id: sub.id, workspace_id: workspaceId },
    });
    return { success: true, internal: true, summary: "Triggered internal renewal (order now)" };
  }

  // Appstle sub: attempt the upcoming Appstle billing.
  const upcoming = await appstleGetUpcomingOrders(workspaceId, contractId);
  if (!upcoming.success || !upcoming.orders?.length) {
    return { success: false, error: `No upcoming order to bill: ${upcoming.error || "(empty)"}` };
  }
  const billed = await appstleAttemptBilling(workspaceId, upcoming.orders[0].id);
  return { ...billed, summary: "Triggered bill_now" };
}

export async function appstleSkipUpcomingOrder(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; error?: string }> {
  // Internal subs have no Appstle billing attempts — advance the next
  // billing date locally instead of calling Appstle (which 405s / 400s
  // on an internal contract id). Mirrors appstleSkipNextOrder's guard so
  // the admin dashboard "skip" works for internal subs too.
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubSkipNextOrder(workspaceId, contractId);
  }
  await healOnTouch(workspaceId, contractId);
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/skip-upcoming-order?subscriptionContractId=${contractId}&shop=${creds.shop}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle skip upcoming order error for contract ${contractId}:`, text);
      return { success: false, error: text || `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle skip upcoming order failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleUnskipOrder(
  workspaceId: string,
  billingAttemptId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/unskip-order/${billingAttemptId}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle unskip order error for ${billingAttemptId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle unskip order failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSwitchPaymentMethod(
  workspaceId: string,
  contractId: string,
  paymentMethodId: string,
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    // Internal flow: the "paymentMethodId" passed in IS our
    // braintree_payment_method_token (callers will be updated to pass
    // it). Mark it as the customer's default active method so the
    // next renewal picks it up.
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("customer_id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (!sub?.customer_id) return { success: false, error: "Internal subscription not found" };
    // Demote the old default, promote the new token.
    await admin
      .from("customer_payment_methods")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("customer_id", sub.customer_id)
      .eq("is_default", true);
    const { error } = await admin
      .from("customer_payment_methods")
      .update({ is_default: true, status: "active", updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("customer_id", sub.customer_id)
      .eq("braintree_payment_method_token", paymentMethodId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  }
  await healOnTouch(workspaceId, contractId);
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-existing-payment-method?contractId=${contractId}&paymentMethodId=${encodeURIComponent(paymentMethodId)}`,
      {
        method: "PUT",
        headers: { "X-API-Key": creds.apiKey },
      }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      // Appstle's own authoritative guardrail: it refuses to switch the
      // payment method while a billing-cycle / contract edit is in flight
      // (400 UserGeneratedError, "billing cycle contract edit"). This is
      // an expected, user-generated transient — NOT a server error — so
      // log at warn and surface a stable error code the caller can retry.
      // Mirrors the recognizer shape in appstleRemoveLineItem.
      const lower = text.toLowerCase();
      if (
        res.status === 400 &&
        lower.includes("usergeneratederror") &&
        lower.includes("billing cycle contract edit")
      ) {
        console.warn(
          `[appstleSwitchPaymentMethod] contract-edit guardrail for contract ${contractId}:`,
          res.status,
          text.slice(0, 200),
        );
        return { success: false, error: "contract_edit_in_progress" };
      }
      console.error(`Appstle switch payment method error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle switch payment method failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSendPaymentUpdateEmail(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    // Internal subs don't piggyback on Appstle's payment-update email
    // pipeline. Our own card-update flow will live elsewhere — return
    // a clear "not yet" instead of pretending to send.
    return internalSubNotYetSupported("send_payment_update_email");
  }
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-payment-method?contractId=${contractId}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle send payment update email error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle send payment update email failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleAddFreeProduct(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    // Same DB shape as add_item, just with price_cents = 0.
    const { internalSubAddItem } = await import("@/lib/internal-subscription");
    const r = await internalSubAddItem(workspaceId, contractId, variantId, quantity);
    if (!r.success) return r;
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, items")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (sub) {
      type Item = { variant_id?: string | number; price_cents?: number };
      const items = ((sub.items as Item[]) || []).map((i: Item) =>
        String(i.variant_id) === String(variantId) ? { ...i, price_cents: 0 } : i,
      );
      await admin.from("subscriptions").update({ items, updated_at: new Date().toISOString() }).eq("id", sub.id);
    }
    return { success: true };
  }
  await healOnTouch(workspaceId, contractId);
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const params = new URLSearchParams({
      contractId,
      variantId,
      quantity: String(quantity),
      price: "0",
      isOneTimeProduct: "true",
    });
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contract-add-line-item?${params}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle add free product error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle add free product failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSwapProduct(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
): Promise<{ success: boolean; error?: string }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    const { internalSubSwapVariant } = await import("@/lib/internal-subscription");
    return internalSubSwapVariant(workspaceId, contractId, oldVariantId, newVariantId);
  }
  await healOnTouch(workspaceId, contractId);
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await loggedAppstleFetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-swap?contractId=${contractId}&oldVariantId=${oldVariantId}&newVariantId=${newVariantId}&api_key=${creds.apiKey}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle swap error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle swap failed:", err);
    return { success: false, error: String(err) };
  }
}
