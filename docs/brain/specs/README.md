# Backlog — active projects + recently shipped

Single source of truth for what's being built next, what's parked, and what just shipped. Replaces the loose `project_*.md` files that used to live in agent memory.

## How to use this

- **Status emojis** (per the convention in [[../project-management]]): ⏳ planned · 🚧 in progress · ✅ shipped (then folded + removed).
- Three active project tracks today. Each has shipped sub-phases (documented in the linked lifecycle) and open sub-work that should be promoted into individual `docs/brain/specs/{slug}.md` files as soon as it's concrete enough to fire `/goal` at.
- When a sub-phase ships, fold its content into the relevant lifecycle/table/library pages and delete the spec file (per [[../project-management]] § Folding a shipped spec into the brain).

---

## Active project — Auto-generated blog posts (scheduled) ⏳

**Spec:** [[auto-blog-generation]]

**Why this matters:** a daily engine that turns [[../lifecycles/product-intelligence|product intelligence]] (ingredients, benefits, SEO keywords, real citations) + web research into genuinely useful, human-voiced blog posts with original branded imagery (Nano Banana Pro hero composites the real product pouch). Goals: rank on target keywords, give value to buyers, reinforce value for considerers. A working end-to-end prototype already renders live (`why-people-add-mushrooms-to-their-coffee`). Big design pillar: posts must read human (E-E-A-T: real authors, proprietary data, original imagery, anti-AI voice rules) so search engines don't dismiss them as scaled AI content. Open questions in the spec.

## Active project — Automated Organic Social Scheduler ⏳

**Spec:** [[automated-social-scheduler]]

**Why this matters:** always-on organic posts/reels/stories to FB + IG for customer engagement, sourced from existing assets (campaign avatar-holding-product images, finished ad videos, blog resources) with PI-grounded copy. Live test 2026-06-10 proved our current page tokens can publish on both platforms — no new scopes. Rolling 7-day window: daily planner cron tops up the calendar, Inngest publishes each post at its time. Dashboard shows posted + scheduled.

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
- 🚧 **Checkout customize-bypass** — [[checkout-customize-bypass]]. Pack-select goes straight to /checkout (skipping /customize); "Customize your order" button on checkout is the opt-in editor. `add_to_cart`/CAPI unaffected (fires at pack-select). Gated on `workspaces.storefront_skip_customize` (on for Superfoods, A/B-toggleable). Built; pending live verify.
- 🚧 **OTP testing** — flow built, awaiting Dylan to test end-to-end on the live storefront.
- ✅ **New-sub vs add-to-existing-sub UI** — shipped (Phase 4.6 in [[../lifecycles/storefront-checkout]]). Three-way choice card (`new_sub` / `add_to_sub` / `renewal_only`) shows when an OTP-verified customer with an active **internal** sub buys a subscribe item. Prevents the "Jennifer Santiago = 2 parallel Superfood Tabs subs" pattern.
- ⏳ **Combine-into-sub: Appstle targets + migrate-on-combine** — the next refinement. **Today is safe but conservative:** `/api/checkout/existing-subs` filters `is_internal=true`, so an Appstle sub is never a combine target (and `appendCartItemsToSub` hard-refuses non-internal subs). Net invariant — *combining always ends in an internal sub* — already holds; the only cost is a customer whose sole sub is Appstle sees no combine card and creates a parallel internal sub (the post-checkout sweep migrates the Appstle one separately → two internal subs). **The deferred work:** surface Appstle subs as combine targets too, and honor the invariant by migrating. Rules (settled with Dylan 2026-06-14): `renewal_only` (no charge / no fresh PM) → **internal targets only**; `add_to_sub` ("order now + add", vaults a card) → may target an Appstle sub by calling `migrateCustomerAppstleSubsToInternal(ws, customer)` **before** `appendCartItemsToSub` (PM is already vaulted by that point, so `findBillableCustomer` succeeds and the flip makes the sub internal → append works). Touch points: `existing-subs` route (return Appstle subs + an `is_internal`/type flag), `CheckoutClient.tsx` (per-target: Appstle ⇒ only "order now + add", disable "next renewal only" with a note), `checkout/route.ts` add_to_sub branch (migrate-first ordering), defense-in-depth guard rejecting `renewal_only` against a non-internal target. **Open UX fork (unasked):** for an Appstle target, order-now-only+migrate (recommended) vs. allow renewal-only via saved default card vs. keep hidden. Promote to its own spec when picked up: `specs/checkout-combine-appstle-migrate.md`.
- ⏳ **Survey chapter + converter-first PDP reorder** — [[storefront-survey-chapter]]. PDP audit (2026-06-15) found the money drop is engaged→pack_selected (5.3%), a ~70% hero cliff, and the quiz popup is structurally dead (3 shows ever — discount signals fire + lock first). Plan: make the survey a visible PDP chapter (sidesteps the dead quiz decider + captures zero-party data), reorder chapters converter-first (why-this-works + ingredients above price), and relocate low-reach detail chapters *below* the price table as opt-in "learn more" (Dylan: don't cut them). Phase 1 (popup funnel dashboard panel) already built.
- ✅ **Shopify theme management via ShopCX (AI-driven, short-term)** — [[shopify-theme-via-shopcx]]. Shipped 2026-06-16. Chat→build theme edits ship to the live store via GitHub commits (Option A); Shopify's GitHub integration auto-deploys. `src/lib/shopify-theme.ts` (Shopify read + GitHub commit) + `scripts/reconcile-shopify-theme.ts`. Reconciliation run: 32 genuinely-drifted files (`settings_data.json` + template JSONs) committed to catch the repo up to live (98 JSON files correctly skipped as serialization-only); re-run shows 0 diff. Workflow + single-writer guardrail: [[../recipes/edit-shopify-theme]].

---

**Cross-cutting (storefront × ad builder):**
- 🚧 **Auto-generated advertorial landers** — [[advertorial-landers]] (P1–P4 code-complete on branch `advertorial-landers`; lifecycle [[../lifecycles/advertorial-landers]]). When an ad campaign hits `ready`, auto-generate a matched advertorial landing page (per ad *angle*) reusing the ad's assets (angle, hero image, script) + the PDP's working sections (ingredients, price table, checkout). Zero manual design; scent-match by construction. Targets the proven 86%→24% hero cliff (funnel data in the spec). Auto-design scope = editorial hero + chapter 1 only; everything below is the existing PDP reused. `product_id` attribution on checkout/order shipped. Remaining: migration apply + Inngest sync + A/B.

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
- ✅ **Portal: "Resources" sidebar** — [[blog-resources]] **shipped 2026-06-10**: 36 blog articles imported → `posts` (35 product resources), images migrated off Shopify, AI-classified (product + grouping), portal Resources UI live (search + product→grouping + reader). Import ran as a 36-agent workflow. Remaining = future phases only (storefront post rendering, RAG embedding for AI citations, periodic re-sync).
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
- 🚧 **Killer statics — cold-50+ archetypes, both formats** — [[killer-statics]] (code-complete + typechecked on branch `killer-statics-iso`; remaining ops = apply the landing_url migration, redeploy the Lambda site, verify a render, run `scripts/seed-killer-statics.ts`, Dylan design pass). Replaces the loud brutalist `AdStatic` with a trust-first archetype system (advertorial editorial serif · testimonial · authority · big-claim · before/after), rendered 4:5 **and** 9:16 (safe-zone aware), auto-built from PI + existing ad assets, audience-aware selection, + the Lambda static-image fix. **Copy rules:** anchor angles to weight/aging/best-self/social (never energy/no-crash); review counts = actual + 10,000; use real `product_media` assets (real endorser photo, real before/after).
- ✅ **Publish ads to Meta (2026-06-10)** — campaign-page "Publish to Meta": generate copy (4 headlines + 4 primary texts + CTA), pick page → ad account → campaign → ad set, upload video → creative (dynamic) → ad (PAUSED default). `src/lib/meta-ads.ts` + `ad-meta-copy.ts` + `ad_publish_jobs` + Inngest `adToolPublishToMeta`. Read-side verified live. Folded into [[../lifecycles/ad-publish]]; spec deleted.
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
