# Backlog — in-flight + planned + roadmap

Single source of truth for what's being built next, what's parked, and what just shipped. Replaces the loose `project_*.md` files that lived in agent memory.

## How to use this

- **Status emojis** (per the convention in [[../project-management]]): ⏳ planned · 🚧 in progress · ✅ shipped (then folded + removed).
- **Items in the "Ready" section** are concrete enough to fire `/goal do everything in docs/brain/specs/{slug}.md` against, once promoted to their own spec file.
- **Roadmap items** are tracked here but don't get individual spec files until promoted to "Ready."
- **Move things between sections** as priorities shift. The order within a section is rough priority.
- When an item ships, fold its content into the relevant lifecycle/table/library pages and delete the row here (the spec file too, if it had one).

---

## Active specs (in flight)

| Status | Spec | Summary |
|---|---|---|
| ⏳🚧 | [ad-tool](ad-tool.md) | Avatar + LF8 ad-angle generator + Higgsfield render pipeline. Phase 0/0.5 in progress. |

---

## Ready to spec — data integrity / cleanup

Concrete, scoped, high-ROI work. Pick any one and promote to a full spec.



---

## Ready to spec — storefront

### Storefront — own the checkout (active umbrella project, needs more spec'ing)
**Status:** 🚧 In flight as one ongoing project. Many sub-phases already shipped; next phases need to be spec'd out.

**Sub-phases shipped (per [[../lifecycles/storefront-checkout]]):**
- PDP pixel, cart create + server-validated pricing
- Braintree Hosted Fields checkout
- Avalara tax quote at checkout (recent)
- OTP gate (`/api/checkout/otp/{start,verify,resend}`)
- Subscription choice card (`/api/checkout/existing-subs`) — three options when authenticated + cart contains subscribe items + active internal sub
- CAPI fan-out

**Active sub-work (parallel project — needs spec'ing here):**
- Add-to-existing-subscription at checkout — one-time purchase now, then promote into an existing sub. Replaces the "modal: do you want to add to your existing sub?" idea with an explicit OTP-gated dual flow.
- Whatever else the storefront-v2 push is taking on next.

**How to use this:** when ready to expand, promote each next sub-phase into its own `docs/brain/specs/{slug}.md` file (e.g. `specs/checkout-add-to-sub.md`) instead of speccing into this index entry.

---

## Reference / runbooks (not work items)

These have no work attached — they're operational notes. Kept here because they were in memory; fold into recipes/ on next pass.

- **DB lockup diagnosis runbook** (`project_db_lockup_diagnosis.md`) — past root cause was missing index on `sms_campaign_recipients.message_sid` during MDW SMS sends. Use `scripts/pg-stat-statements.ts` + `scripts/pg-live-snapshot.ts` against the pooler. Should move to `docs/brain/recipes/db-lockup-diagnosis.md`.

---

## Recently shipped (delete from this index after the next pass)

- ✅ **Prompt-learning auto-review** (2026-06-03) — now in [[../lifecycles/ai-learning]].
- ✅ **Demographic enrichment lifecycle** (2026-06-03) — now in [[../lifecycles/demographic-enrichment]].
- ✅ **Product Intelligence Engine, ShopGrowth removal** (2026-06-03) — now in [[../lifecycles/product-intelligence]].
- ✅ **CSAT** (2026-06) — now in [[../lifecycles/csat]].
- ✅ **Customer voice / operational rules / UI conventions** brain pages (2026-06).
- ✅ **Email tracking spec** — mostly shipped; verify current state in [[../inngest/deliver-pending-send]] / Resend integration page if anyone touches it again.
- ✅ **Stuck-sub cleanup** (2026-06-03) — `next_billing_date` cleanup across 83 subs: 75 advanced (Appstle truth synced into our DB), 6 marked cancelled, 2 re-fired into dunning via `appstleAttemptBilling`. Was a one-time data-staleness backlog, not an active bug (the sync-lag root cause was already patched earlier). Script: `scripts/cleanup-stuck-subs-2026-06-03.ts`.
- ✅ **Cancel-event dedup** (2026-06-03) — forward fix in the Appstle webhook handler. When a customer cancels via the portal, both a `portal.subscription.cancelled` (source=portal) AND a `subscription.cancelled` (source=appstle) fire within seconds. Now the Appstle webhook checks for a portal cancel for the same `shopify_contract_id` within the last 5 min and suppresses the duplicate insert. **Historical 272 duplicates left in place** — backfill script (`scripts/backfill-cancel-event-dedup.ts`) exists but was not applied; analytics consumers can still dedupe at query time if needed.
- ✅ **Stacked-sale-coupon check** (2026-06-03) — re-scoped per Dylan to "subs with **2+** sale coupons (excluding loyalty / free-shipping / Buy-N bundle)." Live count: **0**. The 333 subs that carry one CODE_DISCOUNT each are allowed to combine with automatic-discount + subscribe-and-save. Item resolved without cleanup.
- ✅ **Auto-grant detection removed** (2026-06-03) — three stubbed triggers (`cancelled_but_charged` / `duplicate_charge` / `never_delivered`) were never wired up. Per Dylan: `never_delivered` is handled by the replacement flow; the other two should not happen and Sonnet escalates them directly when they do. Stripped the `checkAutoGrant` function, the auto-grant for-loop in the playbook executor, the auto-grant editor in `/dashboard/settings/playbooks`, the simulate-route auto-grant block, and the AUTO label in the playbook-fix logger. Schema columns + 1 dormant DB row retained (executor filter `!e.auto_grant` is a defensive backstop).
- ✅ **Meta ad-comment attribution** — shipped. Matches `creative.effective_object_story_id` (FB) / `effective_instagram_media_id` (IG) on adcreatives against the webhook's `post.id` / `media.id` so the bimodal ad-vs-organic webhook shape no longer breaks attribution.
- ✅ **Klaviyo 180d engagement backfill** — shipped via local script. Engagement events from Klaviyo's history backfilled into our DB; verify current state via [[../integrations/klaviyo]] before extending.
- ✅ **UX/product bucket cleared** (all 6 items shipped or superseded): (1) parallel-sub alert at checkout — superseded by OTP-then-add-to-sub work in a separate project; (2) SMS phone preview component — shipped (`src/components/sms-phone-preview.tsx`); (3) SMS buyer archetypes + replenishment ratio — shipped; (4) predicted-purchase segments — shipped; (5) return-request auto-playbook — shipped via the refund playbook; (6) shipping-issues Opus chat — shipped.
- ✅ **Analytics + integrations bucket cleared** (all shipped, not-needed, or folded into the storefront umbrella): ROAS analytics — shipped; billing forecast — shipped; Amazon pricing UI — shipped; automation analytics dashboard — not needed; anomaly-aware data tools — shipped via the ticket timeline anomaly-detection feature; cross-app shared API keys (ShopCX / ShopGrowth / Shoptics) — not needed.

---

## Past incident (kept for pattern-matching)

- **Apr 13 ticket glitch** — false-positive close + return response + 529 errors. Originally in `project_ticket_glitch_apr13.md`. If it recurs, check that file before re-investigating from scratch.

---

## Related

[[../project-management]] · [[../README]]
