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

  // Fire-and-forget click logging. We don't await so the redirect
  // is as fast as possible — typical SMS click is on cellular where
  // every extra round-trip is felt.
  void logClick(admin, request, shortlink);

  return NextResponse.redirect(shortlink.target_url, 302);
}

async function logClick(
  admin: ReturnType<typeof createAdminClient>,
  request: NextRequest,
  shortlink: { id: string; workspace_id: string; click_count: number },
) {
  try {
    const ua = request.headers.get("user-agent") || null;
    const country = request.headers.get("x-vercel-ip-country") || null;
    const referrer = request.headers.get("referer") || null;
    const recipientHint = request.nextUrl.searchParams.get("r"); // recipient id

    await admin.from("marketing_shortlink_clicks").insert({
      workspace_id: shortlink.workspace_id,
      shortlink_id: shortlink.id,
      recipient_id: recipientHint || null,
      user_agent: ua,
      ip_country: country,
      referrer,
    });

    const now = new Date().toISOString();
    await admin
      .from("marketing_shortlinks")
      .update({
        click_count: shortlink.click_count + 1,
        last_clicked_at: now,
        ...(shortlink.click_count === 0 ? { first_clicked_at: now } : {}),
      })
      .eq("id", shortlink.id);
  } catch {
    // Click logging is best-effort. A swallowed error here is far
    // less bad than slowing down the redirect.
  }
}

function notFound() {
  return new NextResponse("Not found", { status: 404 });
}
