/**
 * Shortlink redirect handler.
 *
 * Two entry paths:
 *   1. Direct: a customer pastes sprfd.co/ABC123 into a browser.
 *      Middleware (src/lib/supabase/middleware.ts) detects that the
 *      hostname matches workspaces.shortlink_domain, rewrites the
 *      request path to /api/sl/{slug}, and we end up here.
 *   2. Internal preview: an admin clicks a shortlink in the dashboard
 *      and we route to /api/sl/{slug}?ws={workspaceId} so we know
 *      which workspace the slug belongs to without the domain hop.
 *
 * Resolution priority — the slug uniqueness is per-workspace, so we
 * need a workspace hint. When middleware rewrites, it appends ?ws=
 * with the matched workspace_id. Otherwise we fall back to looking
 * across all workspaces (unique enough at 6 chars Crockford-base32
 * that a global lookup is fine; if collisions ever happen we ship
 * a hostname carve-out).
 *
 * The handler:
 *   - resolves slug → target_url
 *   - logs a row in marketing_shortlink_clicks (UA, country, referrer)
 *   - increments click_count, sets first/last_clicked_at on the
 *     parent shortlink row
 *   - 302 redirects to target_url
 *
 * Errors fall through to a 404 — we never leak which slugs exist.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;
  if (!slug) return notFound();

  const url = request.nextUrl;
  const workspaceHint = url.searchParams.get("ws");
  // Per-customer code (the second URL segment, /SLUG/CUSTCODE) — middleware
  // forwards it as ?c=. Uppercase + length-bounded to keep the lookup cheap
  // and ignore obvious junk.
  const rawCustCode = url.searchParams.get("c");
  const customerCode = rawCustCode && /^[0-9A-Z]{4,8}$/i.test(rawCustCode) ? rawCustCode.toUpperCase() : null;

  const admin = createAdminClient();

  // Look up the shortlink. Prefer the workspace hint when present.
  let query = admin
    .from("marketing_shortlinks")
    .select("id, workspace_id, target_url, is_active, expires_at, click_count")
    .eq("slug", slug.toUpperCase())
    .eq("is_active", true);
  if (workspaceHint) {
    query = query.eq("workspace_id", workspaceHint);
  }
  const { data: shortlink } = await query.maybeSingle();

  if (!shortlink || !shortlink.target_url) return notFound();
  if (shortlink.expires_at && new Date(shortlink.expires_at) < new Date()) {
    return notFound();
  }

  // Resolve the customer code synchronously — needed for the cookie. Cheap
  // (single indexed lookup), and we want sx_customer on the redirect response.
  let resolvedCustomerId: string | null = null;
  if (customerCode) {
    const { data: cust } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", shortlink.workspace_id)
      .eq("short_code", customerCode)
      .maybeSingle();
    resolvedCustomerId = cust?.id || null;
  }

  // Click logging + engagement event. Both MUST be awaited — Vercel
  // serverless kills any unresolved promises the moment the redirect
  // response is returned, so a `void logClick(...)` pattern silently
  // dropped the marketing_shortlink_clicks insert AND the
  // profile_events insert. See feedback_vercel_fire_and_forget memory.
  //
  // Running in parallel keeps the added latency to a single DB round
  // trip (~30-80ms), which is well under the cellular page-load wait
  // the customer's already incurring.
  await Promise.all([
    logClick(admin, request, shortlink, resolvedCustomerId),
    resolvedCustomerId
      ? logEngagement(admin, shortlink, resolvedCustomerId)
      : Promise.resolve(),
  ]);

  const response = NextResponse.redirect(shortlink.target_url, 302);
  if (resolvedCustomerId) {
    // Identifies the customer for the storefront pixel + lead-capture flows.
    // SameSite=Lax + Secure + HttpOnly per the storefront cookie conventions.
    response.cookies.set("sx_customer", resolvedCustomerId, {
      path: "/", maxAge: 60 * 60 * 24 * 60, // 60 days
      httpOnly: true, sameSite: "lax", secure: true,
    });
  }
  return response;
}

async function logClick(
  admin: ReturnType<typeof createAdminClient>,
  request: NextRequest,
  shortlink: { id: string; workspace_id: string; click_count: number },
  customerId: string | null,
) {
  try {
    const ua = request.headers.get("user-agent") || null;
    const country = request.headers.get("x-vercel-ip-country") || null;
    const referrer = request.headers.get("referer") || null;
    const recipientHint = request.nextUrl.searchParams.get("r"); // recipient id

    const now = new Date().toISOString();
    // Run both writes in parallel — different rows, no ordering
    // constraint between them, so we keep redirect latency tight.
    const { error: insertErr } = await admin.from("marketing_shortlink_clicks").insert({
      workspace_id: shortlink.workspace_id,
      shortlink_id: shortlink.id,
      recipient_id: recipientHint || null,
      customer_id: customerId,
      user_agent: ua,
      ip_country: country,
      referrer,
    });
    if (insertErr) console.error("[shortlink] click insert failed:", insertErr.message);

    const { error: updErr } = await admin
      .from("marketing_shortlinks")
      .update({
        click_count: shortlink.click_count + 1,
        last_clicked_at: now,
        ...(shortlink.click_count === 0 ? { first_clicked_at: now } : {}),
      })
      .eq("id", shortlink.id);
    if (updErr) console.error("[shortlink] counter update failed:", updErr.message);
  } catch (err) {
    // Click logging is best-effort. Log the error so a real schema or
    // RLS drift surfaces in Vercel logs instead of silently swallowing.
    console.error("[shortlink] logClick threw:", err);
  }
}

async function logEngagement(
  admin: ReturnType<typeof createAdminClient>,
  shortlink: { id: string; workspace_id: string },
  customerId: string,
) {
  try {
    // Lookup the campaign id so segmentation can attribute the click
    // back to the campaign. Lightweight indexed lookup.
    const { data: link } = await admin
      .from("marketing_shortlinks")
      .select("campaign_id")
      .eq("id", shortlink.id)
      .maybeSingle();
    const { error } = await admin.from("profile_events").insert({
      workspace_id: shortlink.workspace_id,
      customer_id: customerId,
      metric_name: "Clicked SMS",
      datetime: new Date().toISOString(),
      attributed_campaign_id: link?.campaign_id || null,
    });
    if (error) console.error("[shortlink] profile_event insert failed:", error.message);
  } catch (err) {
    console.error("[shortlink] logEngagement threw:", err);
  }
}

function notFound() {
  return new NextResponse("Not found", { status: 404 });
}
