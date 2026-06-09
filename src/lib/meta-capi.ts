/**
 * Meta Conversions API (CAPI) — server-side event forwarding.
 *
 * Storefront-mvp spec Phase 3. We run BOTH the browser pixel (fbq) and
 * this server CAPI stream, deduped on a shared `event_id`. CAPI-only
 * yields poor match quality because the browser pixel is what sets
 * `_fbp`/`_fbc`; the two together is Meta's 2026 guidance for paid
 * accounts.
 *
 * Credentials live in [[event_sinks]].config for the `meta_capi` sink:
 *   { pixel_id, access_token_enc, test_event_code? }
 * Only the access token is secret (AES-256-GCM via crypto.ts); the
 * pixel_id is public (it ships in the browser snippet).
 *
 * The fan-out (storefront_events → event_dispatches → here) is driven by
 * the Inngest cron in inngest/meta-capi-dispatch.ts. This module is the
 * pure sender + payload builder + sink resolver.
 */
import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const GRAPH_VERSION = "v21.0";

export interface MetaSink {
  sinkId: string;
  pixelId: string;
  accessToken: string;
  testEventCode: string | null;
  eventTypes: string[]; // empty = all
}

/**
 * Our first-party event types → Meta standard events. Must mirror
 * META_EVENT_MAP in storefront-pixel.ts so browser + server fire the
 * same event name under the same event_id. Events not here are never
 * forwarded to Meta.
 */
export const META_EVENT_MAP: Record<string, string> = {
  pdp_view: "ViewContent",
  add_to_cart: "AddToCart",
  checkout_view: "InitiateCheckout",
  order_placed: "Purchase",
  lead_captured: "Lead",
};

export function metaEventName(storefrontType: string): string | null {
  return META_EVENT_MAP[storefrontType] || null;
}

/**
 * Resolve the active meta_capi sink for a workspace, decrypting the
 * access token. Returns null if none configured / inactive / missing
 * required config. Server-only (touches the encrypted token).
 */
export async function getActiveMetaSink(workspaceId: string): Promise<MetaSink | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("event_sinks")
    .select("id, config, event_types")
    .eq("workspace_id", workspaceId)
    .eq("sink_type", "meta_capi")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const config = (data.config || {}) as { pixel_id?: string; access_token_enc?: string; test_event_code?: string };
  if (!config.pixel_id || !config.access_token_enc) return null;
  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token_enc);
  } catch {
    return null;
  }
  return {
    sinkId: data.id as string,
    pixelId: config.pixel_id,
    accessToken,
    testEventCode: config.test_event_code || null,
    eventTypes: (data.event_types as string[]) || [],
  };
}

/** Pixel id only (public) — for the browser snippet. No decryption. */
export async function getMetaPixelId(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("event_sinks")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("sink_type", "meta_capi")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const pixelId = (data?.config as { pixel_id?: string } | undefined)?.pixel_id;
  return pixelId || null;
}

// ── hashing + normalization (Meta requires SHA-256 of normalized PII) ──

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const norm = email.trim().toLowerCase();
  return norm ? sha256(norm) : null;
}

function hashPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Digits only; Meta wants country code included. We don't force +1 —
  // store whatever digits we have (US numbers already carry it in most
  // captured data; bare 10-digit gets a leading 1).
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return digits ? sha256(digits) : null;
}

function hashName(name: string | null | undefined): string | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  return norm ? sha256(norm) : null;
}

function hashLower(value: string | null | undefined): string | null {
  if (!value) return null;
  const norm = value.trim().toLowerCase().replace(/\s+/g, "");
  return norm ? sha256(norm) : null;
}

/**
 * Derive Meta's `_fbc` from an fbclid when the browser cookie wasn't
 * captured. Format: fb.1.<unix_ms>.<fbclid>. Improves match quality for
 * server events that landed without the cookie.
 */
export function deriveFbc(fbc: string | null, fbclid: string | null, eventTimeMs: number): string | null {
  if (fbc) return fbc;
  if (!fbclid) return null;
  return `fb.1.${eventTimeMs}.${fbclid}`;
}

export interface CapiUserData {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  externalId?: string | null; // customer/anonymous id (hashed)
  clientIp?: string | null;
  clientUserAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

function buildUserData(u: CapiUserData): Record<string, unknown> {
  const ud: Record<string, unknown> = {};
  const em = hashEmail(u.email);
  const ph = hashPhone(u.phone);
  const fn = hashName(u.firstName);
  const ln = hashName(u.lastName);
  const ct = hashLower(u.city);
  const st = hashLower(u.state);
  const zp = hashLower(u.zip);
  const country = hashLower(u.country);
  if (em) ud.em = [em];
  if (ph) ud.ph = [ph];
  if (fn) ud.fn = [fn];
  if (ln) ud.ln = [ln];
  if (ct) ud.ct = [ct];
  if (st) ud.st = [st];
  if (zp) ud.zp = [zp];
  if (country) ud.country = [country];
  if (u.externalId) ud.external_id = [sha256(String(u.externalId))];
  // IP + UA + fbp/fbc are NOT hashed.
  if (u.clientIp) ud.client_ip_address = u.clientIp;
  if (u.clientUserAgent) ud.client_user_agent = u.clientUserAgent;
  if (u.fbp) ud.fbp = u.fbp;
  if (u.fbc) ud.fbc = u.fbc;
  return ud;
}

export interface CapiEvent {
  eventName: string; // Meta standard event
  eventId: string; // = storefront_events.id, for dedup
  eventTimeSec: number;
  eventSourceUrl?: string | null;
  userData: CapiUserData;
  customData?: Record<string, unknown>;
}

/**
 * Send a batch of events to Meta's CAPI for one sink. Returns the HTTP
 * status + body so the dispatcher can record it on event_dispatches.
 * Never throws on a non-2xx — returns it for the caller to log/retry.
 */
export async function sendCapiEvents(
  sink: MetaSink,
  events: CapiEvent[],
): Promise<{ ok: boolean; status: number; body: string }> {
  if (events.length === 0) return { ok: true, status: 204, body: "" };

  const data = events.map((e) => {
    const row: Record<string, unknown> = {
      event_name: e.eventName,
      event_time: e.eventTimeSec,
      event_id: e.eventId,
      action_source: "website",
      user_data: buildUserData(e.userData),
    };
    if (e.eventSourceUrl) row.event_source_url = e.eventSourceUrl;
    if (e.customData && Object.keys(e.customData).length > 0) row.custom_data = e.customData;
    return row;
  });

  const payload: Record<string, unknown> = { data };
  if (sink.testEventCode) payload.test_event_code = sink.testEventCode;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${sink.pixelId}/events?access_token=${encodeURIComponent(sink.accessToken)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 2000) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}
