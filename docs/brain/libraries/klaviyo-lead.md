# libraries/klaviyo-lead

Push a storefront lead into Klaviyo as a profile + (when consented) email/SMS subscriber (storefront-mvp Phase 4f/5).

**File:** `src/lib/klaviyo-lead.ts`

`upsertKlaviyoLead(workspaceId, { email, phone, firstName, lastName, properties, emailConsent, smsConsent })`. Reads the workspace Klaviyo key via `getKlaviyoCredentials` ([[klaviyo]]). Two calls: `POST /api/profile-import/` (upsert profile, incl. custom `properties` like cups_per_day / health_goal) + `POST /api/profile-subscription-bulk-create-jobs/` (consent) for the channels opted into.

**Best-effort + non-fatal:** a missing key or API hiccup never blocks the lead from saving to our own tables. Called fire-and-forget from `/api/lead`. The **Meta CAPI Lead** is NOT fired here — it flows via the client `lead_captured` storefront event → the CAPI cron (deduped on event_id), so it isn't double-sent.

---

[[../README]] · [[klaviyo]] · [[meta-capi]] · [[../lifecycles/storefront-checkout]] · [[../../CLAUDE]]
