// Main portal route handler — replaces standalone subscriptions-portal backend
// All requests: GET/POST /api/portal?route={routeName}
// Auth: Shopify App Proxy HMAC-SHA256 (Shopify extension) OR encrypted cookie session (mini-site)

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

// Defense-in-depth cap: never let a portal request hold a Lambda past 30s,
// even if a per-fetch portalFetch deadline is missed. See
// [[docs/brain/libraries/portal__helpers]] § portalFetch.
export const maxDuration = 30;

import { requireAppProxy, type PortalAuthResult } from "@/lib/portal/auth";
import { routeMap } from "@/lib/portal/handlers";
import { decrypt } from "@/lib/crypto";
import { logCustomerEvent } from "@/lib/customer-events";
import { findCustomer, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
// Phase 2: every subscription mutation is gated while the first-delivery window
// holds — the route list lives with the gate itself so it can be unit-tested.
import { MUTATION_GATED_ROUTES } from "@/lib/portal/mutation-guard";

function jsonErr(body: Record<string, unknown>, status = 400) {
  return NextResponse.json({ ok: false, ...body }, { status });
}

// Stable messages thrown by resolveAuth() when a visitor lands on the portal without a
// valid cookie session — the 401 response is correct, no log line needed.
const EXPECTED_AUTH_MISS = new Set([
  "No portal session",
  "Invalid portal session",
  "Portal session expired",
]);

async function resolveAuth(req: NextRequest): Promise<PortalAuthResult> {
  // Try HMAC auth first (Shopify App Proxy)
  const url = new URL(req.url);
  if (url.searchParams.has("signature")) {
    return requireAppProxy(req);
  }

  // Fall back to cookie session (mini-site portal)
  const cookieStore = await cookies();

  // Magic link cookies (new)
  const magicCustomerId = cookieStore.get("portal_customer_id")?.value;
  const magicWorkspaceId = cookieStore.get("portal_workspace_id")?.value;

  if (magicCustomerId && magicWorkspaceId) {
    // Look up shopify_customer_id from our DB
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();
    const { data: cust } = await admin.from("customers")
      .select("shopify_customer_id")
      .eq("id", magicCustomerId)
      .single();

    let shopifyId = cust?.shopify_customer_id || "";

    // If no shopify_customer_id, check linked accounts
    if (!shopifyId) {
      const { data: link } = await admin.from("customer_links")
        .select("group_id").eq("customer_id", magicCustomerId).maybeSingle();
      if (link) {
        const { data: linked } = await admin.from("customer_links")
          .select("customer_id").eq("group_id", link.group_id).neq("customer_id", magicCustomerId);
        for (const l of linked || []) {
          const { data: lCust } = await admin.from("customers")
            .select("shopify_customer_id").eq("id", l.customer_id).single();
          if (lCust?.shopify_customer_id) {
            shopifyId = lCust.shopify_customer_id;
            break;
          }
        }
      }
    }

    return {
      shop: "",
      loggedInCustomerId: shopifyId,
      workspaceId: magicWorkspaceId,
    };
  }

  // Legacy encrypted session cookie
  const sessionCookie = cookieStore.get("portal_session")?.value;
  if (!sessionCookie) throw new Error("No portal session");

  let session: { shopify_customer_id: string; workspace_id: string; exp: number };
  try {
    session = JSON.parse(decrypt(sessionCookie));
  } catch {
    throw new Error("Invalid portal session");
  }

  if (!session || Date.now() > session.exp) throw new Error("Portal session expired");

  return {
    shop: "",
    loggedInCustomerId: session.shopify_customer_id,
    workspaceId: session.workspace_id,
  };
}

async function handle(req: NextRequest) {
  try {
    const auth = await resolveAuth(req);
    const url = new URL(req.url);

    const route = (url.searchParams.get("route") || "bootstrap").toLowerCase();
    const handler = routeMap[route];

    if (!handler) {
      return jsonErr({ error: "unknown_route", route }, 400);
    }

    // Capture request body for error logging
    let requestPayload: unknown = null;
    if (req.method === "POST") {
      try { requestPayload = await req.clone().json(); } catch { /* not JSON */ }
    }

    // First-delivery gate: EVERY subscription mutation is blocked until the
    // first order is delivered (anti-gaming). Centralized here so it covers both
    // the in-house + Shopify portals. Phase 2 expanded the set from just
    // content/schedule/discount to every lifecycle + payment + address + order-now
    // route — the sub is truly read-only during the first-delivery window. Route
    // list is exported from [[mutation-guard]] so it stays testable.
    if (MUTATION_GATED_ROUTES.has(route) && auth.workspaceId && auth.loggedInCustomerId) {
      const payloadObj = (requestPayload || {}) as Record<string, unknown>;
      const sub = await resolveSub(createAdminClient(), auth.workspaceId, payloadObj.contractId, auth.loggedInCustomerId);
      if (sub?.id) {
        const { canMutateSubscription } = await import("@/lib/portal/mutation-guard");
        const gate = await canMutateSubscription(auth.workspaceId, sub as { id: string; is_internal?: boolean | null });
        if (!gate.allowed) {
          return jsonErr({ error: "first_order_not_delivered", message: gate.reason, state: gate.state }, 403);
        }
      }
    }

    const response = await handler({ req, url, auth, route });

    // Log error responses for portal analytics visibility
    // Skip validation errors (expected user input issues, not real errors)
    // would_remove_last_item / would_remove_all_regular_products are benign
    // UI-gating guardrails (the portal should never offer the action that empties
    // a subscription) — same class as insufficient_points. Suppress here so a
    // legitimate last-item removal never spawns a portal-action-failed ticket.
    const VALIDATION_ERRORS = new Set(["date_too_early", "date_too_far", "invalid_date", "missing_contractId", "missing_nextBillingDate", "missing_address1", "missing_city", "missing_provinceCode", "missing_zip", "no_changes", "not_logged_in", "first_order_not_delivered", "insufficient_points", "would_remove_last_item", "would_remove_all_regular_products"]);
    // Some validation errors carry a dynamic message instead of a stable code
    // (e.g. loyalty redeem returns "Insufficient points. Need 1500, have 297").
    // These are UI-gating issues — the portal should never offer the action —
    // so they must NOT spawn a "needs help" ticket. Match by pattern too.
    const isValidationError = (err: string) =>
      VALIDATION_ERRORS.has(err) || /^insufficient points/i.test(err || "");
    if (response.status >= 400 && auth.workspaceId && auth.loggedInCustomerId) {
      try {
        const body = await response.clone().json();
        if (isValidationError(body?.error)) { /* skip logging validation errors */ }
        else {
        const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
        if (customer) {
          await logCustomerEvent({
            workspaceId: auth.workspaceId,
            customerId: customer.id,
            eventType: "portal.error",
            source: "portal",
            summary: `Portal error on ${route}: ${body?.error || response.status}`,
            properties: {
              route,
              status: response.status,
              error: body?.error || null,
              // Handlers carry the friendly text in `detail` (not `message`),
              // so capture both — the remediation layer keys off this text to
              // dismiss UI-gating validation errors. See [[portal-remediation]].
              message: body?.message || null,
              detail: body?.detail || null,
              appstle_details: body?.appstle_details || null,
              request_payload: requestPayload,
            },
          });

          // The portal UI promises "we're submitting a ticket on your behalf"
          // when an action fails — so actually create one (tagged, so a view
          // can collect them) and the agent gets the full context. Light
          // dedupe: reuse an open `portal-action-failed` ticket from the last
          // hour instead of spawning a new one per retry.
          try {
            const { createAdminClient } = await import("@/lib/supabase/admin");
            const adminDb = createAdminClient();
            const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
            const { data: existing } = await adminDb
              .from("tickets")
              .select("id")
              .eq("workspace_id", auth.workspaceId)
              .eq("customer_id", customer.id)
              .contains("tags", ["portal-action-failed"])
              .neq("status", "closed")
              .gte("created_at", hourAgo)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            const errText = body?.message || body?.detail;
            const note = `[System] Customer's portal action failed and could not self-serve.\nAction: ${route}\nError: ${body?.error || response.status}${errText ? ` — ${errText}` : ""}\nDetails: ${JSON.stringify(requestPayload || {})}`;
            let ticketId = existing?.id as string | undefined;
            if (!ticketId) {
              const { data: ticket } = await adminDb
                .from("tickets")
                .insert({
                  workspace_id: auth.workspaceId,
                  customer_id: customer.id,
                  channel: "portal",
                  status: "open",
                  subject: `Portal action needs help: ${route}`,
                  tags: ["portal-action-failed"],
                  last_customer_reply_at: new Date().toISOString(),
                })
                .select("id")
                .single();
              ticketId = ticket?.id as string | undefined;
            }
            if (ticketId) {
              await adminDb.from("ticket_messages").insert({
                ticket_id: ticketId,
                direction: "inbound",
                visibility: "internal",
                author_type: "system",
                body: note,
              });
            }
          } catch (e) {
            console.error("[portal] error-ticket create failed (non-fatal):", e instanceof Error ? e.message : e);
          }
        }
        } // end else (not validation error)
      } catch { /* non-fatal */ }
    }

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unauthorized";

    if (message === "APP_PROXY_INVALID_SIGNATURE") {
      return jsonErr({ error: "unauthorized", message: "Invalid signature" }, 401);
    }

    // Expected cookie-session auth-misses — a visitor hits the portal without a valid
    // session. The 401 IS the correct response; logging it via console.error feeds the
    // Vercel log drain → Control Tower (signature vercel:1a3270b4a24a9960) and pages
    // owners on a healthy auth-miss. Genuine unexpected throws still log.
    if (EXPECTED_AUTH_MISS.has(message)) {
      return jsonErr({ error: "unauthorized", message }, 401);
    }

    console.error("[portal] route error:", message);
    return jsonErr({ error: "unauthorized", message }, 401);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

// Support HEAD for health checks
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
