import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logCustomerEvent } from "@/lib/customer-events";

export function jsonOk(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

export function jsonErr(body: Record<string, unknown>, status = 400) {
  return NextResponse.json({ ok: false, ...body }, { status });
}

export function clampInt(n: unknown, fallback: number): number {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

// Typeof-guarded String.prototype.startsWith for values that originate from
// request input (body fields, query params, URL fragments) — a body field the
// client sends as a number/object/null used to crash the portal with
// `t.startsWith is not a function` (signature vercel:a08795a29d9404a4), and the
// outer /api/portal try-catch mislabeled it as `[portal] route error:` +
// returned 401 Unauthorized. Handlers that already coerce via `s()` still call
// this at the .startsWith site so a future refactor removing the coerce can't
// silently reintroduce the crash.
export function safeStartsWith(v: unknown, prefix: string): boolean {
  return typeof v === "string" && v.startsWith(prefix);
}

/**
 * fetch() with a bounded per-request deadline. A stalled upstream (Appstle,
 * Shopify GraphQL, Braintree, Avalara) can otherwise hold a portal Lambda open
 * for the full 300s Vercel ceiling — the customer sees a hung request and the
 * platform emits a runtime timeout. Wrap every portal-side outbound fetch with
 * this so we surface a clean upstream_timeout error the existing
 * handleAppstleError / jsonErr paths convert into a 502-class response.
 */
export async function portalFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = 20_000,
): Promise<Response> {
  try {
    return await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      throw new Error("upstream_timeout");
    }
    throw e;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All customer UUIDs in the caller's link group (incl. self). Linking is display-only. */
async function customerLinkGroupIds(
  admin: ReturnType<typeof createAdminClient>,
  customerId: string,
): Promise<string[]> {
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
  const ids = (group || []).map((r) => r.customer_id as string);
  return ids.length ? ids : [customerId];
}

export interface ResolvedSub {
  id: string;
  shopify_contract_id: string | null;
  is_internal: boolean;
  status: string | null;
  customer_id: string;
  last_payment_status: string | null;
  items: unknown;
  next_billing_date: string | null;
  applied_discounts: unknown;
}

/**
 * Resolve a portal subscription by the identifier the client sends.
 *
 * Our system keys on the subscription UUID. The contract id (Appstle/Shopify) is
 * an external detail used ONLY when talking to Appstle — callers read
 * `sub.shopify_contract_id` at that boundary and `sub.id` everywhere else. We
 * still accept the legacy contract-id shape here so in-flight migrated subs (whose
 * frontend payloads carry `internal-…`) keep working during the transition.
 *
 * Enforces that the sub belongs to the logged-in customer's link group — portal
 * handlers previously looked subs up globally by contract id with no ownership
 * check.
 */
export async function resolveSub(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  rawId: unknown,
  loggedInShopifyCustomerId: string,
): Promise<ResolvedSub | null> {
  const id = typeof rawId === "string" ? rawId.trim() : rawId == null ? "" : String(rawId);
  if (!id || !workspaceId || !loggedInShopifyCustomerId) return null;

  const { data: customer } = await admin.from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", loggedInShopifyCustomerId)
    .maybeSingle();
  if (!customer) return null;
  const groupIds = await customerLinkGroupIds(admin, customer.id);

  // UUID column can't be compared against a non-UUID literal — branch on shape.
  const base = admin.from("subscriptions")
    .select("id, shopify_contract_id, is_internal, status, customer_id, last_payment_status, items, next_billing_date, applied_discounts")
    .eq("workspace_id", workspaceId)
    .in("customer_id", groupIds);
  if (UUID_RE.test(id)) {
    const { data } = await base.eq("id", id).maybeSingle();
    return (data as ResolvedSub | null) || null;
  }
  // Contract-id shape: match the current id OR a migrated_from_contract_id, so a
  // migrated customer's STALE numeric id resolves to their live internal sub
  // rather than the cancelled Appstle shell the migration left behind. Prefer the
  // internal (migrated) row, then the newest, so the live sub always wins.
  // Only the raw-string `.or()` filter (unlike a parameterized `.eq`) is exposed
  // to PostgREST filter injection, so gate it on a safe contract-id charset;
  // anything else can't be a real contract id anyway → parameterized `.eq`.
  const SAFE_CONTRACT_ID = /^[A-Za-z0-9_-]+$/;
  if (!SAFE_CONTRACT_ID.test(id)) {
    const { data } = await base.eq("shopify_contract_id", id).maybeSingle();
    return (data as ResolvedSub | null) || null;
  }
  const { data } = await base
    .or(`shopify_contract_id.eq.${id},migrated_from_contract_id.eq.${id}`)
    .order("is_internal", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ResolvedSub | null) || null;
}

export function shortId(gid: unknown): string {
  const s = String(gid || "");
  if (!s) return "";
  const parts = s.split("/");
  return parts[parts.length - 1] || s;
}

export function addDaysFromNow(days: number): string {
  const ms = Date.now() + days * 24 * 60 * 60 * 1000 + 15 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Find customer in our DB by Shopify customer ID.
 */
export async function findCustomer(workspaceId: string, shopifyCustomerId: string) {
  if (!workspaceId || !shopifyCustomerId) return null;
  const admin = createAdminClient();
  const { data } = await admin.from("customers")
    .select("id, email, first_name, last_name, shopify_customer_id, default_address")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .single();
  return data;
}

/**
 * Log a portal action to customer_events and optionally create an internal ticket note.
 */
export async function logPortalAction(params: {
  workspaceId: string;
  customerId: string;
  eventType: string;
  summary: string;
  properties?: Record<string, unknown>;
  createNote?: boolean;
}) {
  const { workspaceId, customerId, eventType, summary, properties, createNote } = params;

  await logCustomerEvent({
    workspaceId,
    customerId,
    eventType,
    source: "portal",
    summary,
    properties: properties || {},
  });

  if (createNote) {
    const admin = createAdminClient();
    // Find most recent open/pending ticket for this customer
    const { data: ticket } = await admin.from("tickets")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .in("status", ["open", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (ticket) {
      await admin.from("ticket_messages").insert({
        ticket_id: ticket.id,
        direction: "internal",
        visibility: "internal",
        author_type: "system",
        body: `[Portal] ${summary}`,
      });
    }
  }
}

/**
 * Check if a customer is banned from portal self-serve.
 * Returns a 403 response if banned, null otherwise.
 */
export async function checkPortalBan(workspaceId: string, shopifyCustomerId: string) {
  if (!workspaceId || !shopifyCustomerId) return null;
  const admin = createAdminClient();
  const { data } = await admin.from("customers")
    .select("portal_banned")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .single();
  if (data?.portal_banned) {
    return jsonErr({ error: "account_restricted" }, 403);
  }
  return null;
}

/**
 * Wrap Appstle errors into portal-friendly responses.
 */
export function handleAppstleError(e: unknown, context?: { route?: string; payload?: unknown }): NextResponse {
  const err = e as { message?: string; status?: number; details?: unknown };
  if (err?.message === "Appstle not configured") {
    return jsonErr({ error: "missing_appstle_config" }, 500);
  }
  return jsonErr({
    error: "appstle_error",
    message: err?.message || "Unknown error",
    appstle_details: err?.details || null,
    request_payload: context?.payload || null,
  }, 502);
}
