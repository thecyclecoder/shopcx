/**
 * winback-shortlink — one SMS shortlink that sends EACH customer to THEIR OWN win-back journey.
 *
 * WHY (CEO 2026-11-23, Wave 1 follow-up): the win-back restart is a per-customer journey session
 * (`/journey/{token}`, bound to one customer + one subscription — see [[reactivate-journey-builder]]).
 * A marketing text carries ONE shortlink per campaign (`sprfd.co/SLUG/CUSTCODE`), and its
 * `target_url` is the same for everyone, so a text could not deep-link each customer to their own
 * restart page. Email could (the token is in the email), SMS could not.
 *
 * HOW: a campaign whose shortlink target path is the sentinel `/journey/@winback` is resolved at
 * click time by `/api/sl/[slug]`: the per-customer code (`/CUSTCODE` → `customers.short_code`)
 * identifies the customer, and we redirect to their newest PENDING, unexpired win-back journey
 * session (journey_definitions.trigger_intent in REACTIVATE_JOURNEY_TYPES), keeping the query string
 * (UTMs). A completed session (already restarted / declined) never matches, so a restarted customer
 * can't restart twice from a text. When nothing matches — unknown customer, no live session — the
 * `fallback` query param is used (e.g. the store home page), else the site root.
 *
 * Example target: https://shopcx.ai/journey/@winback?fallback=https%3A%2F%2Fsuperfoodscompany.com
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { REACTIVATE_JOURNEY_TYPES } from "@/lib/winback-reactivate-choice";

type Admin = ReturnType<typeof createAdminClient>;

export const WINBACK_JOURNEY_SENTINEL_PATH = "/journey/@winback";

/** True when a shortlink target asks for per-customer win-back resolution. */
export function isWinbackSentinel(targetUrl: string): boolean {
  try {
    return new URL(targetUrl).pathname === WINBACK_JOURNEY_SENTINEL_PATH;
  } catch {
    return false;
  }
}

/** Pure: build the redirect from the sentinel target + a token (or null → fallback). */
export function buildWinbackRedirect(targetUrl: string, token: string | null): string {
  const url = new URL(targetUrl);
  const fallback = url.searchParams.get("fallback");
  url.searchParams.delete("fallback");
  if (!token) {
    if (fallback) {
      try { return new URL(fallback).toString(); } catch { /* bad fallback → site root */ }
    }
    return `${url.origin}/`;
  }
  url.pathname = `/journey/${token}`;
  return url.toString();
}

/** The customer's newest pending, unexpired win-back session token, or null. */
export async function findWinbackToken(
  admin: Admin, workspaceId: string, customerId: string,
): Promise<string | null> {
  const { data: defs } = await admin.from("journey_definitions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("trigger_intent", [...REACTIVATE_JOURNEY_TYPES]);
  const journeyIds = (defs || []).map((d) => d.id as string);
  if (!journeyIds.length) return null;
  const { data: session } = await admin.from("journey_sessions")
    .select("token")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("journey_id", journeyIds)
    .eq("status", "pending")
    .gt("token_expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (session?.token as string | undefined) || null;
}

/** Resolve a sentinel shortlink target for one click. Never throws: falls back on any error. */
export async function resolveWinbackTarget(
  admin: Admin, workspaceId: string, customerId: string | null, targetUrl: string,
): Promise<string> {
  let token: string | null = null;
  if (customerId) {
    try {
      token = await findWinbackToken(admin, workspaceId, customerId);
    } catch (e) {
      console.error("[winback-shortlink] token lookup failed:", e);
    }
  }
  return buildWinbackRedirect(targetUrl, token);
}
