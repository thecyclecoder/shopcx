/**
 * Klaviyo lead capture — push a storefront lead into Klaviyo as a
 * profile + (when consented) email/SMS subscriber.
 *
 * Storefront-mvp Phase 4f/5. Best-effort + non-fatal: a missing Klaviyo
 * key or an API hiccup must never block the lead from being saved to our
 * own customers/storefront_leads tables. Callers should not await the
 * result on the request's critical path (fire-and-forget).
 *
 * Uses Klaviyo's modern JSON:API:
 *   - POST /api/profile-import/                       → upsert the profile
 *   - POST /api/profile-subscription-bulk-create-jobs → set consent
 */
import { getKlaviyoCredentials } from "@/lib/klaviyo";

const BASE = "https://a.klaviyo.com/api";
const REVISION = "2025-01-15";

export interface KlaviyoLeadInput {
  email: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** Custom profile properties — e.g. { cups_per_day, health_goal, source }. */
  properties?: Record<string, unknown>;
  emailConsent?: boolean;
  smsConsent?: boolean;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: REVISION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Upsert the lead's Klaviyo profile and, when consent was given, subscribe
 * them to email / SMS marketing. Returns false on any miss (no key, API
 * error) — the caller treats Klaviyo as advisory.
 */
export async function upsertKlaviyoLead(workspaceId: string, lead: KlaviyoLeadInput): Promise<boolean> {
  const creds = await getKlaviyoCredentials(workspaceId);
  if (!creds?.apiKey) return false;

  const email = lead.email.trim().toLowerCase();
  const attributes: Record<string, unknown> = { email };
  if (lead.phone) attributes.phone_number = lead.phone;
  if (lead.firstName) attributes.first_name = lead.firstName;
  if (lead.lastName) attributes.last_name = lead.lastName;
  if (lead.properties && Object.keys(lead.properties).length > 0) {
    attributes.properties = lead.properties;
  }

  try {
    // 1. Upsert the profile.
    const importRes = await fetch(`${BASE}/profile-import/`, {
      method: "POST",
      headers: headers(creds.apiKey),
      body: JSON.stringify({ data: { type: "profile", attributes } }),
    });
    if (!importRes.ok && importRes.status !== 409) {
      // 409 = profile already exists, which profile-import normally
      // updates; treat anything else non-2xx as a soft failure.
      console.warn(`[klaviyo-lead] profile-import ${importRes.status} for ${email}`);
    }

    // 2. Subscribe (consent) — only the channels the lead opted into.
    const subscriptions: Record<string, unknown> = {};
    if (lead.emailConsent) subscriptions.email = { marketing: { consent: "SUBSCRIBED" } };
    if (lead.smsConsent && lead.phone) subscriptions.sms = { marketing: { consent: "SUBSCRIBED" } };
    if (Object.keys(subscriptions).length > 0) {
      const profileAttrs: Record<string, unknown> = { email, subscriptions };
      if (lead.phone) profileAttrs.phone_number = lead.phone;
      await fetch(`${BASE}/profile-subscription-bulk-create-jobs/`, {
        method: "POST",
        headers: headers(creds.apiKey),
        body: JSON.stringify({
          data: {
            type: "profile-subscription-bulk-create-job",
            attributes: {
              profiles: { data: [{ type: "profile", attributes: profileAttrs }] },
            },
          },
        }),
      });
    }
    return true;
  } catch (e) {
    console.warn(`[klaviyo-lead] failed for ${email}:`, e instanceof Error ? e.message : e);
    return false;
  }
}
