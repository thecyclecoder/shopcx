# Backlog — active projects + recently shipped

Single source of truth for what's being built next, what's parked, and what just shipped. Replaces the loose `project_*.md` files that used to live in agent memory.

## How to use this

- **Status emojis** (per the convention in [[../project-management]]): ⏳ planned · 🚧 in progress · ✅ shipped (then folded + removed).
- Three active project tracks today. Each has shipped sub-phases (documented in the linked lifecycle) and open sub-work that should be promoted into individual `docs/brain/specs/{slug}.md` files as soon as it's concrete enough to fire `/goal` at.
- When a sub-phase ships, fold its content into the relevant lifecycle/table/library pages and delete the spec file (per [[../project-management]] § Folding a shipped spec into the brain).

---

## Active project 1 — Storefront 🚧

**Lifecycle:** [[../lifecycles/storefront-checkout]]

**Why this matters:** owning the checkout removes the 3% Shopify txn fee, unlocks AOV boosters + custom sub-conversion logic, and prevents the hidden-parallel-sub pattern that bites us repeatedly.

**Feedback surface:** bugs + structural gaps this project surfaces in tickets route back through the [[../lifecycles/agent-todo-system]] queue (now shipped — [[../lifecycles/agent-todo-system]]) as `code_change` / `brain_doc_edit` todos.

**Sub-phases shipped:**
- PDP pixel, cart create + server-validated pricing
- Braintree Hosted Fields checkout
- Avalara tax quote at checkout (recent)
- OTP gate (`/api/checkout/otp/{start,verify,resend}`)
- Subscription choice card (`/api/checkout/existing-subs`)
- CAPI fan-out

**Open sub-work:**
- 🚧 **OTP testing** — flow built, awaiting Dylan to test end-to-end on the live storefront.
- 🚧 **New-sub vs add-to-existing-sub UI** — at checkout, when a customer with an active subscription buys a subscribe item, present the choice: create a new parallel sub, add the line to the existing sub, or just one-time-purchase. Prevents the "Jennifer Santiago = 2 parallel Superfood Tabs subs for 7 months" pattern. Promote to its own spec when ready: `specs/checkout-add-to-sub.md`.

---

## Active project 2 — Customer portal 🚧

**Lifecycle:** [[../lifecycles/customer-portal]]

**Why this matters:** the in-house portal is replacing the Shopify-extension surface. Once it owns full sub-management it can do things the Shopify ext can't — better cancel-save UX, in-portal storefront flows, loyalty redemption, payment update without leaving the page.

**Feedback surface:** portal bugs + gaps surfaced in tickets route back through the [[../lifecycles/agent-todo-system]] queue (now shipped — [[../lifecycles/agent-todo-system]]) as `code_change` / `brain_doc_edit` todos.

**Sub-phases shipped (per lifecycle page):**
- Both surfaces (Shopify extension + in-house mini-site) wired
- Cancel-via-journey, loyalty redeem + apply, coupon validation
- Address + frequency + line-item mutations
- Payment-method update with Appstle → internal migration on card change
- Identity linking, event log + internal ticket notes

**MVP hardening shipped (2026-06-10):** account linked-accounts list + email read-only, first-delivery mutation gate (both portals), support sidebar tickets across linked accounts (archived read-only), payment-recovery magic-link emails + dunning visibility. The in-house portal is **adequately hardened for MVP**.

**Open sub-work:**
- ⏳ **Portal: finish "Resources" sidebar** — the Resources section exists but is incomplete; flesh out the content/data it surfaces. (Later session.)
- ⏳ **Portal: add "Promotions" sidebar item** — net-new sidebar section for active promotions/offers. (Later session.)
- ⏳ **Portal: add "Shop" sidebar item** — net-new sidebar section for in-portal shopping (re-order / add products without leaving the portal). (Later session.)
- 🚧 **New customer portal** (v2) — net-new surface being built. Scope to be spec'd: which capabilities move from the Shopify ext to the in-house surface, what the design system looks like, how it co-exists with the existing in-house mini-site under `/portal`. Promote to its own spec when concrete: `specs/customer-portal-v2.md`.
- ⏳ **Appstle pricing heal + migration monitor** — [[appstle-pricing-heal-and-migration-monitor]]. One Appstle gateway that heals `pricingPolicy:null` subs on touch (validated live), smart migration that reads `pricingPolicy.basePrice` directly (heal-by-migration), and a post-payment-method verification monitor (retry-then-flag) so we never lose a renewal. Design + decisions settled 2026-06-09; ready to build.

---

## Active project 3 — Ad builder tool 🚧

**Lifecycle:** [[../lifecycles/ad-render]]

**Why this matters:** cut per-ad creative cost from ~$200 (freelancer) to ~$2 (Higgsfield + Whisper + Anthropic), and cut turnaround from days to ~5 minutes per ad. Enables ROAS-driven creative iteration at the cadence the Meta dashboard needs.

**Sub-phases shipped (per lifecycle page):**
- Schema: [[../tables/ad_avatars]], [[../tables/ad_avatar_proposals]], [[../tables/ad_campaigns]], [[../tables/ad_videos]], [[../tables/ad_jobs]], [[../tables/product_ad_angles]]
- Product-asset prep: `product_variants.isolated_image_url` + `physical_dimensions` columns + UI uploads on `/dashboard/storefront/products/[id]`
- Libraries: ad-angles, ad-script, ad-validator, ad-render, ad-tool-config, ad-avatar-proposals, ad-transcribe, ad-storage, higgsfield
- API surface: `/api/ads/*` (campaigns, avatars, angles, proposals, validate, hero/audio/talking-head/render) + `/api/workspaces/{id}/ad-tool-settings`
- Dashboard: `/dashboard/marketing/ads/*`

**Shipped since (2026-06): the proven model stack + creative library**
- Gemini engine wired: Nano Banana Pro hero, Veo 3.1 Fast talking heads + b-roll, Lyria music. TTS dropped (VO = Veo native audio).
- Creative library ([[../tables/ad_segments]] + `ad_campaigns.composition`): every piece persisted + reusable; staged Production UI; per-clip refresh + HQ-Veo-3 regenerate; b-roll studio (text / animate-photo / reuse-from-library, keep/discard); Gemini settings card. First real ad built + saved.
- ✅ **Production render runtime → Remotion Lambda (2026-06-05)** — render runs on AWS Lambda (Vercel serverless can't run Remotion); Whisper transcription folded into the render so captions never come back empty; durable re-signed URLs. Provisioned + verified (ad rendered on Lambda in ~39s). Folded into [[../lifecycles/ad-render]] + [[../integrations/remotion-lambda]]; spec deleted.

- ✅ **Static ads — separate design-led process (2026-06-05)** — three designed archetypes (review screenshot · offer card · benefit/authority), hybrid engine, rendered on Lambda across 1:1/4:5/9:16 from product intelligence. Verified in-app (Inngest → Lambda). Folded into [[../lifecycles/ad-static]]; spec deleted.

**Open sub-work:**
- ⏳ **TODO (Dylan): static-ad design tweaks** — the static pipeline ships, but the *visual design* of the three archetypes is a first pass and needs Dylan's review/iteration. All visual changes live in `remotion/StaticAds.tsx` + `DEFAULT_BRAND` (`src/lib/ad-static.ts`); preview via sample render, then re-run `scripts/deploy-remotion-lambda.ts`. Details + checklist in [[../lifecycles/ad-static]] § Status / open work.
- Minor: NBP backdrop auto-gen for offer cards; editable-copy UI before static render; native/UGC archetype; only talking beats refreshable via UI ([[../lifecycles/ad-render]] / [[../lifecycles/ad-static]] § Open).

---

## Reference / runbooks (not work items)

- **DB lockup diagnosis runbook** — past root cause was missing index on `sms_campaign_recipients.message_sid` during MDW SMS sends. Use `scripts/pg-stat-statements.ts` + `scripts/pg-live-snapshot.ts` against the pooler. Should move to `docs/brain/recipes/db-lockup-diagnosis.md` next pass.

---

## Past incident (kept for pattern-matching)

- **Apr 13 ticket glitch** — false-positive close + return response + 529 errors. Originally in `project_ticket_glitch_apr13.md`. If it recurs, check that file before re-investigating from scratch.

---

## Recently shipped (delete from this index after the next pass)

- ✅ **Agent To-Do system** (2026-06-08) — live end-to-end: the hourly routine reasons over escalated tickets, proposes todos into the `/dashboard/tickets/todos` approval queue, customer-facing approvals execute via the Inngest worker, and system-level todos open `claude/*` PRs that owners squash-merge from `/dashboard/branches`. The common feedback surface for the other projects. Now in [[../lifecycles/agent-todo-system]]; spec folded + deleted.
- ✅ **Prompt-learning auto-review** (2026-06-03) — now in [[../lifecycles/ai-learning]].
- ✅ **Demographic enrichment lifecycle** (2026-06-03) — now in [[../lifecycles/demographic-enrichment]].
- ✅ **Product Intelligence Engine, ShopGrowth removal** (2026-06-03) — now in [[../lifecycles/product-intelligence]].
- ✅ **CSAT** (2026-06) — now in [[../lifecycles/csat]].
- ✅ **Customer voice / operational rules / UI conventions** brain pages (2026-06).
- ✅ **Email tracking spec** — mostly shipped; verify current state in [[../inngest/deliver-pending-send]] / Resend integration page if anyone touches it again.
- ✅ **Stuck-sub cleanup** (2026-06-03) — `next_billing_date` cleanup across 83 subs: 75 advanced (Appstle truth synced into our DB), 6 marked cancelled, 2 re-fired into dunning via `appstleAttemptBilling`. Was a one-time data-staleness backlog, not an active bug. Script: `scripts/cleanup-stuck-subs-2026-06-03.ts`.
- ✅ **Cancel-event dedup** (2026-06-03) — forward fix in the Appstle webhook handler. When a customer cancels via the portal, the Appstle webhook checks for a portal cancel for the same `shopify_contract_id` within the last 5 min and suppresses the duplicate insert. Historical 272 duplicates left in place; analytics consumers can dedupe at query time if needed.
- ✅ **Stacked-sale-coupon check** (2026-06-03) — re-scoped to "subs with 2+ sale coupons (excluding loyalty / free-shipping / Buy-N bundle)." Live count: 0.
- ✅ **Auto-grant detection removed** (2026-06-03) — three stubbed triggers (`cancelled_but_charged` / `duplicate_charge` / `never_delivered`) never wired up. Sonnet escalates these directly when they occur; `never_delivered` is handled by the replacement flow. Stripped the executor code path + UI editor + simulate route.
- ✅ **Meta ad-comment attribution** — shipped via `effective_object_story_id` / `effective_instagram_media_id` match against the webhook's `post.id` / `media.id`.
- ✅ **Klaviyo 180d engagement backfill** — shipped via local script.
- ✅ **UX/product bucket** — parallel-sub alert (superseded by add-to-existing-sub UI in the storefront project), SMS phone preview, SMS buyer archetypes + replenishment ratio, predicted-purchase segments, return-request auto-playbook (via refund playbook), shipping-issues Opus chat.
- ✅ **Analytics + integrations bucket** — ROAS analytics, billing forecast, Amazon pricing UI, anomaly-aware data tools (via ticket timeline anomaly-detection); automation analytics dashboard + cross-app shared keys marked not needed.

---

## Related

[[../project-management]] · [[../README]]
