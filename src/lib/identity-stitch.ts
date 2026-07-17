/**
 * Identity stitching helpers.
 *
 * Every time a visitor identifies themselves (lead capture, checkout
 * identify, full checkout submit, save-cart) we:
 *   1. Read device + IP-geo from request headers (Vercel populates
 *      x-vercel-ip-country/region/city; we never store raw IP).
 *   2. If an anonymous_id is known (cart cookie / explicit body),
 *      ensure a storefront_sessions row exists and stamp it with the
 *      customer_id.
 *   3. Backfill any storefront_events rows that share the anonymous_id
 *      with the new customer_id so prior pre-identify activity attributes.
 *
 * Steps 2-3 are no-ops when anonymous_id is missing (e.g. server-to-
 * server calls). The visitor enrichment happens regardless so we
 * always know "this customer was last seen from this device + region."
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface VisitorContext {
  user_agent: string | null;
  device_type: "mobile" | "tablet" | "desktop" | null;
  os: string | null;
  browser: string | null;
  ip_country: string | null;
  ip_region: string | null;
  ip_city: string | null;
}

/** Pull device + geo from a Next.js Request. Pure read — no side effects. */
export function readVisitorContext(request: Request): VisitorContext {
  const h = request.headers;
  const ua = h.get("user-agent") || "";
  return {
    user_agent: ua || null,
    device_type: parseDeviceType(ua),
    os: parseOs(ua),
    browser: parseBrowser(ua),
    // Vercel-populated geo headers. Cloudflare uses cf-ipcountry etc;
    // we read both so a future CDN swap doesn't break attribution.
    ip_country: h.get("x-vercel-ip-country") || h.get("cf-ipcountry") || null,
    ip_region: h.get("x-vercel-ip-country-region") || null,
    ip_city: h.get("x-vercel-ip-city") || null,
  };
}

/**
 * Stitch a (workspace, anonymous_id) → customer_id and stamp device
 * + geo on the storefront_sessions row. Backfills the customer_id
 * onto any existing storefront_events rows with the same anonymous_id.
 *
 * Safe to call repeatedly — the session upsert is keyed on the unique
 * (workspace_id, anonymous_id) constraint and events update is filtered
 * to rows missing customer_id only.
 *
 * Returns silently on missing inputs so callers can fire-and-await
 * without conditional branching.
 */
export async function stitchVisitor(opts: {
  workspaceId: string;
  customerId: string;
  anonymousId: string | null | undefined;
  context: VisitorContext;
}): Promise<void> {
  const { workspaceId, customerId, anonymousId, context } = opts;
  if (!anonymousId) return;
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Upsert the session row. If one exists for this anonymous_id we
  // refresh customer_id + last_seen + any device/geo we now know that
  // it didn't capture at first sight (e.g. customer opened the same
  // anonymous_id on a second device). Don't overwrite first-touch
  // attribution fields (UTMs, referrer, landing_url).
  const { data: existing } = await admin
    .from("storefront_sessions")
    .select("id, customer_id, user_agent")
    .eq("workspace_id", workspaceId)
    .eq("anonymous_id", anonymousId)
    .maybeSingle();
  if (existing) {
    const updates: Record<string, unknown> = {
      customer_id: customerId,
      last_seen_at: nowIso,
      updated_at: nowIso,
    };
    // Backfill device/geo if the session row missed them at first
    // touch (e.g. a server-side identify call before any pixel hit).
    if (!existing.user_agent && context.user_agent) {
      updates.user_agent = context.user_agent;
      if (context.device_type) updates.device_type = context.device_type;
      if (context.os) updates.os = context.os;
      if (context.browser) updates.browser = context.browser;
    }
    if (context.ip_country) updates.ip_country = context.ip_country;
    if (context.ip_region) updates.ip_region = context.ip_region;
    if (context.ip_city) updates.ip_city = context.ip_city;
    await admin.from("storefront_sessions").update(updates).eq("id", existing.id);
  } else {
    // Atomic get-or-create: this check-then-insert can race the pixel route (or itself) for the same
    // (workspace_id, anonymous_id) and hit the unique constraint. ON CONFLICT DO NOTHING makes the loser
    // a silent no-op — no Postgres error logged. Any customer_id stitch a lost race skips is healed by
    // the set-when-null customer_id path on the next pixel hit + the events backfill below.
    await admin.from("storefront_sessions").upsert(
      {
        workspace_id: workspaceId,
        anonymous_id: anonymousId,
        customer_id: customerId,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        user_agent: context.user_agent,
        device_type: context.device_type,
        os: context.os,
        browser: context.browser,
        ip_country: context.ip_country,
        ip_region: context.ip_region,
        ip_city: context.ip_city,
      },
      { onConflict: "workspace_id,anonymous_id", ignoreDuplicates: true },
    );
  }

  // Backfill events for this anonymous_id that don't yet have a
  // customer_id. Idempotent — re-runs are no-ops after the first
  // successful stitch.
  await admin
    .from("storefront_events")
    .update({ customer_id: customerId })
    .eq("workspace_id", workspaceId)
    .eq("anonymous_id", anonymousId)
    .is("customer_id", null);
}

// ── UA parsing ────────────────────────────────────────────────────
// Light-touch parsing — we don't need full UA-parser coverage for the
// "what kind of device did this customer sign up from" question. The
// session is also touched at every pixel hit; the storefront pixel
// library does richer parsing client-side when available.

function parseDeviceType(ua: string): "mobile" | "tablet" | "desktop" | null {
  if (!ua) return null;
  if (/iPad|tablet/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
  return "desktop";
}

function parseOs(ua: string): string | null {
  if (!ua) return null;
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

function parseBrowser(ua: string): string | null {
  if (!ua) return null;
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
  if (/Firefox\//.test(ua)) return "Firefox";
  return null;
}
