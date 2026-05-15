@AGENTS.md
@JOURNEYS.md
@CANCEL-FLOW.md
@SONNET-ORCHESTRATOR.md
@CRISIS-MANAGEMENT-SPEC.md
@STOREFRONT.md
@DATABASE.md
@TEXT-MARKETING.md

# ShopCX.ai — The Retention Operating System

## Project Overview
ShopCX.ai replaces Gorgias (helpdesk), Siena AI (customer service AI), Appstle (subscriptions), and Klaviyo (email/SMS marketing + reviews) with a unified platform. Internal-first for Superfoods Company, multi-tenant SaaS architecture from day one.

- **Domain**: https://shopcx.ai
- **GitHub**: https://github.com/thecyclecoder/shopcx
- **Vercel**: dylan-ralstons-projects/shopcx (Pro plan, Next.js framework)
- **Supabase**: project ref `urjbhjbygyxffrfkarqn` (Superfoods Company org)
- **Inngest**: 20+ functions registered
- **Product Spec**: `shopcx-product-spec.html` (9 phases, ~20-22 weeks)

## Tech Stack
- **Frontend**: Next.js 16 (App Router), Tailwind CSS, TypeScript
- **Backend**: Supabase (Postgres + RLS + pgvector), Vercel serverless
- **Background Jobs**: Inngest (durable steps, retries, concurrency control)
- **Email**: Resend (sending + inbound via webhook)
- **AI**: Claude Haiku 4.5 (fast turns) + Claude Sonnet 4 (complex turns) + OpenAI embeddings
- **Integrations**: Shopify (GraphQL + REST + Bulk Operations + webhooks), Appstle (subscriptions API), Klaviyo (product reviews)
- **Encryption**: AES-256-GCM for all stored API keys/tokens

## Architecture Decisions
- **RLS on every table**: workspace_id column, authenticated users get SELECT, service_role gets ALL
- **Admin client pattern**: All writes go through `createAdminClient()` (service_role), never client-side
- **JWT custom hook**: `custom_access_token_hook` injects workspace_id + workspace_role into JWT
- **Workspace context**: Cookie-based (`workspace_id`), resolved in middleware, available via `useWorkspace()` hook
- **Per-workspace credentials**: Shopify, Resend, etc. keys stored encrypted per workspace, not in env vars
- **Sandbox mode**: Default on. AI drafts appear as internal notes, not sent to customers. Agents can "Approve & Send" sandbox drafts.
- **Sonnet Orchestrator v2**: Tool-use architecture. Minimal pre-context + on-demand data tools. DB-driven prompts via `sonnet_prompts` table. See `SONNET-ORCHESTRATOR.md`.
- **Response delays**: All outbound messages use `pending_send_at` — inserted immediately (visible in UI), delivered by cron after delay. Edit/Cancel buttons during pending window.
- **Email tracking**: Self-hosted open pixel + click redirect (no Resend domain tracking). Only on tracked emails (crisis, marketing). See `src/lib/email-tracking.ts`.
- **Ticket channels**: email, chat, help_center, social_comments, meta_dm, sms
- **Chat end**: Messages containing "send you an email" trigger `chatEnded` in widget — disables input, hides typing bubbles, shows "conversation ended"

## Completed Phases

### Phase 1: Workspace, Auth & Multi-Tenancy ✅
- Google OAuth via Supabase
- Workspace create/select/switch
- Roles: owner, admin, agent, social, marketing, read_only
- Invite flow with Resend email
- RLS policies, JWT hook
- Dashboard layout with responsive sidebar (hamburger on mobile)
- Access gate: only admin email + invited users, others see /coming-soon
- PWA manifest, favicon, SEO meta, OG image

### Phase 2: Shopify Integration & Customer Identity ✅
- Shopify OAuth flow (Client ID/Secret per workspace, HMAC verification)
- Discovers real myshopify.com domain via Shop API
- Customer sync via Shopify GraphQL Bulk Operations
- Order sync via Shopify GraphQL Bulk Operations
- Product sync (Online Store channel only via publications API)
- Retention Score v1 (0-100): recency 30%, frequency 25%, LTV 25%, subscription 20%
- Inngest-powered background sync with progress bar
- Shopify webhooks: customers/create, customers/update, orders/create, orders/updated
- Shopify marketing consent: customerEmailMarketingConsentUpdate, customerSmsMarketingConsentUpdate

### Phase 3: Ticketing ✅
- Tickets + ticket_messages tables with RLS
- Email inbound: Resend webhook → create/thread tickets
- Email outbound: Agent replies via Resend with In-Reply-To threading
- Statuses: open, pending, closed. Auto-transitions on reply.
- 7 channels: email, chat, help_center, social_comments, meta_dm, sms, with channel badges
- CSAT: Inngest sends survey 24hrs after closed
- Sandbox mode with "Approve & Send" button on AI drafts
- Rich text reply composer with formatting toolbar
- Ticket queue: filterable by status/channel/assignee/tags, all channels in filter
- Customer sidebar: orders, subscriptions, LTV, retention score
- Collapsible Tickets menu in sidebar with "View All" link
- Delete ticket: owner/admin only
- Handled By: "AI Agent" and "Workflow: [name]" virtual assignees, filterable

### Phase 3b: Rules Engine ✅
- Compound AND/OR conditions, ordered actions, priority
- 8 action types: add/remove tags, set status, assign, auto-reply, internal note, update customer, Appstle actions
- Synchronous evaluation across all event sources

### Phase 3c: Ticket Views ✅
- Saved views with nested hierarchy (2 levels deep)
- Collapsible in sidebar, per-view ticket counts
- Save as View from active filters

### Phase 3d: Escalation ✅
- Separate escalation layer with reason tracking
- AI escalation: cancellation_intent, billing_dispute, human_requested, turn_limit_reached, negative_sentiment, low_confidence, knowledge_gap
- Round-robin agent assignment on escalation
- Holding message when customer requests human
- Escalation banner on ticket detail

### Phase 3e: Smart Patterns ✅
- Global pattern library: 9 categories, 220+ phrases
- 3-layer classifier: keywords → pgvector embeddings → Claude Haiku fallback
- Auto-tags tickets with smart: prefix
- Smart tag feedback loop: agent removal → AI analysis → admin review queue

### Phase 3f: Workflows ✅
- 3 template workflows: Order Tracking, Cancel Request, Subscription Inquiry
- Shopify fulfillment data: carrier events, tracking, shipping address
- 24 template variables, rich text reply templates
- Per-channel response delays (Inngest step.sleep)
- Positive confirmation detection + delayed auto-close
- Manual workflow trigger from ticket detail

### Phase 3g: Customer Identity ✅
- Customer linking across profiles (email, phone, name, address matching)
- Combined orders, subscriptions, tickets across linked profiles
- Customer merge on Shopify webhook

### Phase 4: AI Agent ✅
- **Multi-turn conversations**: Full pipeline — route → assemble context → generate → confidence check → send
- **Turn routing**: Escalation keywords (cancel/billing/human), sentiment detection, positive closure, turn limits
- **Context assembler**: Full customer profile (orders, subscriptions, fulfillments, retention score, marketing status), conversation history with summarization, KB chunks, channel personality
- **Model selection**: Haiku for turns 1-2 (fast/cheap), Sonnet for turns 3+ (smarter)
- **AI response rules**: Max 2 sentences per paragraph, no markdown, mirror customer language, no flattery on follow-ups, sign-off only Turn 1, never ask what it can verify, never claim unperformed actions
- **KB gap detection**: No response when no matching content, creates notification + escalates to human
- **Double-email batching**: Detects new messages during delay, re-assembles context to address all at once
- **Agent intervention tracking**: agent_intervened flag, AI adjusts behavior when agent was in thread
- **Auto-resolve**: Closes ticket after every AI turn, customer reply reopens
- **Sandbox mode**: AI drafts as internal notes, "Approve & Send" button for agents
- **HTML paragraphs**: AI responses wrapped in `<p>` tags for email rendering

### Phase 4a: AI Workflows ✅
- Marketing Signup workflow: detects discount/coupon questions, offers email+SMS signup
- Discount code flow: SHOPCX code for existing subscribers
- Appstle subscription discount: check for existing coupons → remove old → apply SHOPCX
- Shopify marketing consent mutations (email + SMS)
- AI context includes available workflows so AI knows what actions to offer

### Phase 4b: Macro Suggestion System ✅
- macro_usage_log table (per-use tracking with source/outcome)
- dashboard_notifications table (generic notification system)
- Suggestion counters on macros (ai_suggest/accept/reject/edit_count)
- record_macro_suggestion_outcome() RPC for atomic updates
- Notification bell in sidebar with unread count, dropdown panel
- AI pipeline tracks suggestions + creates notifications
- Ticket detail: Use Draft → accepted, Dismiss → rejected, Apply & Personalize → personalized
- Macro acceptance rate badges (green/amber/red) in settings

### Phase 4c: Knowledge Base ✅
- Standalone KB management page with rich text editor (contentEditable + toolbar)
- Help center scraper: Inngest function crawls existing help sites (tested on help.superfoodscompany.com, 200+ articles)
- HTML entity decoding, Gorgias widget stripping
- Product mapping: partial keyword matching against Shopify products
- Article view tracking (view_count), helpful votes (helpful_yes/helpful_no)
- Public help center mini-site: categories, search, "Most Viewed", "Most Helpful", article pages with SEO structured data
- Subdomain routing: superfoods.shopcx.ai → middleware rewrites
- Custom domain support: auto-adds to Vercel via API, CNAME instructions
- Clean URLs: /article-slug on subdomain, /help/slug/article on main domain
- Help center branding: logo upload, primary color picker, ShopCX.ai defaults
- Public ticket creation form with channel "help_center"
- Article feedback widget (thumbs up/down) with API

### Phase 4d: Fraud Detection ✅
- Fraud rules engine: shared_address + high_velocity + address_distance + name_mismatch with configurable thresholds
- **Order hold**: Real-time fraud detection tags Shopify orders "suspicious" via `tagsAdd` GraphQL mutation
  - Fulfillment center holds tagged orders automatically
  - Dismiss case → `tagsRemove` releases orders to fulfillment
  - Confirm fraud → orders stay tagged for manual handling
  - "Orders Held" section on fraud detail page with amber badge
- **Address distance rule**: Billing/shipping zip > threshold miles apart (Haversine + `zipcodes` npm package for US zip centroids)
- **Name mismatch rule**: Billing name ≠ customer name (case-insensitive, ignore if last names match option)
- Fraud case detail: investigation panel with rule triggering, customer accounts, orders, subscriptions, chargebacks, account linking
- Subscription cancel from fraud detail with reason "fraud" via Appstle DELETE endpoint
- Inngest-powered nightly scans + per-order/customer checks + Shopify dispute polling
- Chargeback processing pipeline (received → classify → auto-cancel or review → won/lost)
- Chargeback list: active subscription count column (sortable), account linking in slideout
- Auto-unsubscribe from marketing on chargebacks + fraud detection
- Chargebacks no longer create fraud cases — fraud cases only from actual rules
- Delete fraud cases (admin/owner only)

### Phase 4e: Journeys ✅
- See `JOURNEYS.md` for full journey system documentation
- Combined account linking + discount signup journey
- Multi-step mini-site (branded, mobile-friendly, progress bar)
- Inline multi-step forms in live chat (same logic as mini-site)
- Journey suggestions for agent-assigned tickets
- Re-nudge system for declined signups (server-side via email)
- Per-journey ticket status setting (open/pending/closed on each step)
- **Cancel Journey**: AI-powered subscription retention flow
  - Subscription selection (collapsible cards, shipping protection as green badge not line item)
  - 8 cancel reasons (4 business-critical: too expensive, too much product, not seeing results, reached goals)
  - AI remedy selection: Claude Haiku picks top 3 from `remedies` table + historical success rates per reason
  - Open-ended AI chat: Claude Sonnet for "just need a break" / "something else" / "reached goals" (max 3 turns)
  - Social proof: Klaviyo product reviews below remedies, AI-summarized (max 15 words), "Read full review" expand
  - Remedy outcome tracking: every offer logged to `remedy_outcomes` for system learning
  - Appstle API actions: cancel (DELETE), pause (PUT status), skip next order, frequency change, coupon apply/remove
  - "Are you sure?" confirmation before final cancel (not guilt-trippy)
  - 17px minimum text, max 25 words per remedy pitch
  - **First-renewal detection**: `subscription_age_days < billing_interval_days` = never renewed yet
    - Aggressive save offers (25-40% discounts, "extend your trial" framing)
    - Subscription cards show "Your first shipment" instead of renewal date (avoids payment anxiety)
    - `first_renewal` boolean tracked in `remedy_outcomes` for separate save rate metrics
    - AI prompt includes first-renewal context for Haiku remedy selection
  - Default remedies seeded via `DEFAULT_REMEDIES` in `journey-seed.ts` (9 types: coupon, pause 30/60d, skip, monthly, bimonthly, AI conversation, social proof, specialist)
  - Coupon remedies reference `coupon_mappings` table (AI picks by VIP tier), not hardcoded
- **Klaviyo Integration**: Product reviews for cancel journey social proof
  - Settings → Integrations → Klaviyo card (API key encrypted, public key, sync button, review count, last sync)
  - API key per workspace (encrypted via AES-256-GCM), nightly cron + on-demand sync via Inngest
  - AI review summaries (Haiku, max 15 words) stored in `product_reviews.summary`
  - Featured reviews (`smart_featured` from Klaviyo) prioritized, then highest-rated
  - Reviews matched to customer's subscription products for relevant social proof

### Phase 5: Dunning System ✅
- **Card rotation**: On payment failure, tries all stored payment methods (deduplicated by last4+expiry) with 2h delays
- **Payday-aware retries**: After cards exhausted, retries on 1st, 15th, Fridays, last biz day at 7 AM Central
- **Cycle 1 action**: Skip order (default) — customer gets payment update email
- **Cycle 2 action**: Pause subscription (default) — creates ticket + dashboard notification
- **New card recovery**: Shopify `customer_payment_methods/create|update` webhook → unskip + switch card + bill immediately
- **Appstle endpoints**: attemptBilling, skipUpcomingOrder, unskipOrder, switchPaymentMethod, sendPaymentUpdateEmail
- **Shopify GraphQL**: Customer payment methods query with deduplication
- **Inngest orchestration**: `dunning/payment-failed`, `dunning/new-card-recovery`, `dunning/billing-success`
- **Customer communication**: Silent card rotation → payment update email → recovery confirmation → paused email
- **Settings UI**: Enable/disable, max card rotations, payday retries toggle, cycle 1/2 actions
- **Tags**: `dunning:active`, `dunning:recovered`, `dunning:skipped`, `dunning:paused`
- **Requires**: Appstle built-in retries and skip-after-X-failures turned OFF

### Phase 6: Subscriptions Page ✅
- **List view** (`/dashboard/subscriptions`): Sortable table with status/recovery/payment filters, search, pagination (25/page)
- **Detail view** (`/dashboard/subscriptions/[id]`): Full subscription info, items, recovery timeline, order history, activity log
- **Actions card**: Pause, resume, cancel (with reason), skip next order, bill now, change frequency, change next date
- **Item management**: Add/remove/replace/quantity via Shopify subscription draft workflow (subscriptionContractUpdate → draftLineAdd/Remove/Update → draftCommit)
- **Coupon management**: Apply/remove coupons via Appstle API
- **Recovery integration**: Amber "In Recovery" / Red "Payment Failed" / Green "Recovered" badges on list + detail + customer sidebar
- **Customer sidebar**: Subscription cards clickable → navigate to detail page, recovery badges on failed payment subscriptions
- **Sidebar nav**: "Subscriptions" between Tickets and Customers with refresh icon
- **API endpoints**: List, detail+actions, items CRUD, coupon, bill-now, payment-update
- **Action labels consistent**: Pause subscription, Resume subscription, Cancel subscription, Skip next order, Change delivery frequency, Change next order date, Apply coupon, Process payment now

### Phase 7: Customer Portal Consolidation ✅
- **Backend migration**: All 13 portal route handlers ported to `/api/portal?route={name}` with Shopify App Proxy HMAC auth
- **DB-first lookups**: Subscriptions list/detail read from Supabase, Appstle for mutations only
- **Cancel → Journey**: Portal cancel triggers cancel journey (AI remedies, reviews, save offers) instead of hard cancel
- **Event logging**: Every portal action logged to `customer_events` (portal.subscription.paused, portal.items.swapped, etc.)
- **Internal notes**: Mutation actions create internal ticket notes for agent visibility
- **Reviews**: Uses `product_reviews` table instead of direct Klaviyo API calls
- **Dunning awareness**: Subscription responses include recovery status + payment update URL
- **Linked accounts**: Subscription list includes linked customer profiles
- **Shopify extension**: `shopify-extension/` subfolder, `app_proxy.url` → `shopcx.ai/api/portal`
- **Auth**: `src/lib/portal/auth.ts` — Shopify HMAC-SHA256 verification, resolves workspace from shop domain
- **Route handlers**: bootstrap, home, subscriptions, subscriptionDetail, pause, resume, cancel, reactivate, address, replaceVariants, coupon, frequency, reviews, cancelJourney, dunningStatus
- **Env var**: `SHOPIFY_APP_PROXY_SECRET` for HMAC verification

### Dashboard & Settings ✅
- Dashboard overview: real-time stats (open/pending tickets, customers, avg retention, AI resolution rate, tickets today, KB articles, active macros)
- Settings cards: Rules, AI Agent, Macros, Workflows, Smart Patterns, Fraud Detection, Dunning, Ticket Views, Tags, Team, Import, Integrations, Knowledge Base, Journeys, Chargebacks, Coupons
- Team page: editable display names per member
- Journey settings: detail view with flow visualization, editable steps, channels, match patterns, priority, step ticket status
- Branding: ShopCX.ai (lowercase .ai), notification bell, collapsible tickets menu

## Returns & Refund Pipeline (rewritten 2026-05-14)

End-to-end flow for product returns:

1. **Create return** — `createFullReturn()` (`src/lib/shopify-returns.ts`):
   - Calls Shopify `returnCreate` mutation (creates the Shopify-side return record)
   - Inserts our `returns` row with `status='open'` and `return_line_items` populated with `shopify_rfo_line_item_id`
   - Buys EasyPost label (pinned to USPS, falls back to other carriers only if USPS has no rates)
   - Computes + stores `order_total_cents`, `label_cost_cents`, `net_refund_cents` at this moment — these are the contract for what we'll refund
   - Advances `status='label_created'` independently of Shopify-side reverse-delivery (was previously gated on it)
   - `attachReturnTracking()` creates the Shopify ReverseDelivery (cosmetic — doesn't gate our flow)

2. **EasyPost webhook fires `delivered`** → updates `returns.delivered_at` + sends Inngest event `returns/process-delivery`

3. **`returns/process-delivery`** (`src/lib/inngest/returns.ts`): instantly fires `returns/issue-refund`. No 24h wait, no Shopify dispose call — we don't use their inventory bookkeeping.

4. **`returns/issue-refund`**: reads `net_refund_cents` from the return. If missing/zero, inserts a `dashboard_notifications` row and stops. If present, branches:
   - `refund_return` → `partialRefundByAmount()` on Shopify (exactly the stored amount, not full order)
   - `store_credit_return` → `issueStoreCredit()` via Shopify `storeCreditAccountCredit`
   - Updates `status='refunded'`, sets `refunded_at` + `refund_id`, sends `sendReturnConfirmationEmail`

**Critical rules:**
- Never auto-refund a guessed amount. The contract is set at return-creation time; the pipeline trusts it.
- `freeLabel: true` means we eat the EasyPost cost (label_cost_cents = 0, net = order_total). Crisis returns + tenured-customer goodwill returns use this.
- Customer-pays-shipping returns: label_cost_cents = actual EasyPost rate, net = order_total − label_cost.
- Partial returns: items_subtotal-based net rather than full order (line items only, no tax/shipping refund).
- Improve-tab `create_return` action now uses `createFullReturn` (was setting `is_return: true` directly on EasyPost which made USPS print labels with from/to swapped → packages came back to customers).

**Failures surface as `dashboard_notifications`:**
- `Return refund failed — manual action needed` — Shopify rejected refundCreate (most often `Braintree::AuthenticationError`). Manually refund via Shopify Admin → mark our return refunded with `refund_id='manual-braintree'` and fire confirmation email.
- `Return needs manual review — no refund amount stored` — `net_refund_cents` was missing. Set it manually, re-fire `returns/issue-refund`.

## Inbound Message Handling (Sonnet Orchestrator v2)
All inbound messages go through the unified ticket handler → Sonnet Orchestrator v2:
1. **Resolve** — find customer, check agent_intervened, load channel config
2. **Active playbook** — if ticket has active playbook, execute next step (skip Sonnet)
3. **Sonnet Orchestrator** — analyzes message with tool-use, decides action:
   - `direct_action` → execute immediately (skip, pause, refund, price update, etc.)
   - `journey` → launch cancel/address/discount journey
   - `playbook` → start refund/replacement playbook
   - `workflow` → run order tracking/account login workflow
   - `ai_response` / `kb_response` → send generated/macro response
   - `escalate` → assign to agent with holding message
4. **Auto-close** — only if a customer message was sent. If action failed silently, ticket stays open.

Sonnet's behavior is configured via `sonnet_prompts` table (Settings → AI → Prompts).

## Key Files
- `src/lib/sonnet-orchestrator-v2.ts` — Sonnet v2 with tool-use (LIVE — handles all routing)
- `src/lib/action-executor.ts` — Executes SonnetDecision — direct actions, journeys, playbooks, workflows
- `src/lib/inngest/unified-ticket-handler.ts` — Main pipeline: resolve → playbook → Sonnet → execute
- `src/lib/email-tracking.ts` — Self-hosted open pixel + click redirect tracking
- `src/lib/subscription-items.ts` — Appstle line item mutations (swap, add, remove, price update)
- `src/lib/shopify-order-actions.ts` — Shopify refunds, cancellations, address updates
- `src/lib/supabase/admin.ts` — Service role client for all DB writes
- `src/lib/supabase/server.ts` — SSR client for auth checks
- `src/lib/supabase/middleware.ts` — Auth + workspace + sandbox + subdomain routing
- `src/lib/crypto.ts` — AES-256-GCM encrypt/decrypt for API keys
- `src/lib/rag.ts` — RAG retrieval (KB chunks + macros via pgvector)
- `src/lib/shopify-sync.ts` — Bulk ops, paginated sync, rate limit guard
- `src/lib/shopify-marketing.ts` — Shopify email/SMS marketing consent mutations
- `src/app/api/portal/route.ts` — Main portal route handler (HMAC auth + route dispatch)
- `src/lib/portal/auth.ts` — Shopify App Proxy HMAC-SHA256 verification + workspace resolution
- `src/lib/portal/handlers/` — Portal route handlers (bootstrap, subscriptions, cancel, etc.)
- `src/lib/portal/helpers.ts` — Portal response helpers, event logging, Appstle error handling
- `src/lib/shopify-webhooks.ts` — Customer/order webhook handlers
- `src/lib/inngest/ai-multi-turn.ts` — Multi-turn AI conversation handler (route → context → generate → actions → send)
- `src/lib/inngest/ai-draft.ts` — AI draft + auto-send Inngest function
- `src/lib/inngest/workflow-delayed.ts` — Delayed workflow execution + positive-close
- `src/lib/inngest/scrape-help-center.ts` — Help center scraper with product mapping
- `src/lib/inngest/fraud-detection.ts` — Fraud detection Inngest functions
- `src/lib/inngest/chargeback-processing.ts` — Chargeback pipeline
- `src/lib/workflow-executor.ts` — Template workflows with Shopify fulfillment data
- `src/lib/pattern-matcher.ts` — 3-layer classifier: keywords → embeddings → Claude Haiku
- `src/lib/rules-engine.ts` — Synchronous rule evaluation with compound conditions
- `src/lib/embeddings.ts` — Multi-provider embedding generation (OpenAI, Voyage, HuggingFace)
- `src/lib/appstle.ts` — Appstle API helper (pause/cancel/resume via DELETE with cancellationFeedback + discount apply/remove)
- `src/lib/email.ts` — Resend client, send ticket reply, send CSAT, send invite, send journey CTA
- `src/lib/journey-launcher.ts` — Unified journey launcher (chat inline + email CTA)
- `src/lib/email-journey-builder.ts` — Combined multi-step journey builder for email channel
- `src/lib/discount-journey-builder.ts` — Builds discount journey steps from customer data
- `src/lib/chat-journey.ts` — Code-driven journey executors (account linking, discount signup for chat)
- `src/lib/journey-suggest.ts` — Journey suggestion detection for agent-assigned tickets
- `src/lib/cancel-journey-builder.ts` — Builds cancel journey steps from customer subs + remedies
- `src/lib/remedy-selector.ts` — AI remedy selection (Haiku) + open-ended conversation (Sonnet)
- `src/lib/klaviyo.ts` — Klaviyo API client (reviews sync, retrieval, AI summaries)
- `src/lib/inngest/sync-reviews.ts` — Nightly + on-demand Klaviyo review sync
- `src/lib/dunning.ts` — Core dunning logic: card rotation, payment method dedup, payday scheduling, Shopify payment methods query
- `src/lib/dunning-webhook.ts` — Shopify payment method webhook handler → triggers dunning recovery
- `src/lib/inngest/dunning.ts` — Inngest dunning orchestration: payment-failed, new-card-recovery, billing-success
- `src/app/dashboard/settings/dunning/page.tsx` — Dunning settings UI
- `src/lib/first-touch.ts` — First outbound touch tagging (touched + ft:source)
- `src/lib/ticket-tags.ts` — Idempotent ticket tag helper
- `src/lib/shopify-marketing.ts` — Subscribe + unsubscribe email/SMS marketing via Shopify GraphQL
- `src/lib/shopify-subscriptions.ts` — Shopify subscription draft workflow: add/remove/update line items, change next billing date
- `src/app/dashboard/subscriptions/page.tsx` — Subscription list view with filters, pagination, recovery badges
- `src/app/dashboard/subscriptions/[id]/page.tsx` — Subscription detail with actions, items, recovery, orders, activity
- `src/lib/fraud-detector.ts` — Fraud rules engine (shared_address, high_velocity, address_distance, name_mismatch)
- `src/lib/shopify-order-tags.ts` — Shopify GraphQL tagsAdd/tagsRemove for order hold
- `src/lib/geo-distance.ts` — Haversine distance + US zip code lookup via zipcodes package
- `src/components/notification-bell.tsx` — Dashboard notification bell with dropdown
- `src/app/journey/[token]/page.tsx` — Journey mini-site (multi-step forms, branded)
- `src/app/api/journey/[token]/step/route.ts` — Journey step submission (code-driven executor)
- `src/app/api/journey/[token]/complete/route.ts` — Journey completion (processes all responses, re-nudge, cancel actions)
- `src/app/api/journey/[token]/remedies/route.ts` — AI remedy selection for cancel journey (Haiku)
- `src/app/api/journey/[token]/chat/route.ts` — Open-ended AI conversation for cancel journey (Sonnet)
- `src/app/api/workspaces/[id]/sync-reviews/route.ts` — Trigger Klaviyo review sync
- `src/app/api/validate-phone/route.ts` — Phone validation via Twilio Lookup v2

## Environment Variables (Vercel Production)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — Admin operations
- `NEXT_PUBLIC_SITE_URL` — https://shopcx.ai
- `ENCRYPTION_KEY` — 64-char hex for AES-256-GCM
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Inngest auth
- `ANTHROPIC_API_KEY` — Claude API for AI agent + pattern suggestions
- `OPENAI_API_KEY` — Embeddings via text-embedding-3-small
- `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` — Domain management
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — Twilio (SMS + phone validation via Lookup v2)

## Database Schema (Supabase)
- `workspaces` — Multi-tenant root. Credentials (encrypted), sandbox_mode, response_delays, help_slug, help_custom_domain
- `workspace_members` — User ↔ workspace with role enum
- `customers` — Synced from Shopify. Email, retention_score, subscription_status, LTV, email_marketing_status, sms_marketing_status
- `orders` — Synced from Shopify. Line items, fulfillments JSONB, source_name
- `subscriptions` — From Appstle. Items JSONB, billing interval, next billing date
- `products` — Synced from Shopify Online Store channel. `variants` JSONB is a legacy mirror — the source of truth for variants is `product_variants`. Each JSONB element gets `internal_id` stamped on it so legacy readers can still resolve the UUID.
- `product_variants` — First-class variant rows (UUID PK). Has `shopify_variant_id` (nullable for future internal-only variants) and price/sku/title/option columns. Read via `src/lib/product-variants.ts` helpers (`getProductVariants`, `findVariant`, `getVariantIndex`). New code should reference variants by their internal UUID, not the Shopify ID — this is what unblocks the Shopify deprecation.
- `tickets` — Status, tags, channel, handled_by, ai_turn_count, ai_turn_limit, escalation_reason, agent_intervened, journey_id, journey_step, journey_data, journey_nudge_count, profile_link_completed
- `ticket_messages` — Direction, visibility, author_type (customer/agent/ai/system), macro_id
- `ticket_views` — Saved filter combos with parent_id for nesting
- `knowledge_base` — Articles with slug, published, content_html, view_count, helpful_yes/no, product mapping
- `kb_chunks` — Embeddings for RAG (vector 1536)
- `macros` — Templates with embeddings, usage tracking, AI suggestion counters
- `macro_usage_log` — Per-use tracking with source/outcome
- `smart_patterns` — Global + workspace patterns with embedding vectors
- `workflows` — Template-based (order_tracking, cancel_request, subscription_inquiry, account_login, end_chat)
- `ai_workflows` — AI agent workflows (marketing_signup, etc.)
- `ai_channel_config` — Per-channel AI settings (personality, confidence threshold, auto_resolve, turn_limit)
- `ai_personalities` — Named personalities with tone, style, sign-off, emoji settings
- `rules` — Compound AND/OR conditions, ordered actions
- `dashboard_notifications` — Generic notifications (macro_suggestion, pattern_review, knowledge_gap, system, fraud_alert)
- `fraud_cases` — Fraud detection cases with severity
- `fraud_rules` — Configurable fraud detection rules
- `journey_definitions` — Journey configs with channels, match_patterns, trigger_intent, step_ticket_status, priority
- `journey_sessions` — Per-customer journey invocations with token, config_snapshot, responses, status
- `journey_step_events` — Append-only audit log of journey responses
- `chargeback_events` — Shopify disputes with reason/status mapping, auto_action_taken
- `chargeback_subscription_actions` — Log of subscription cancellations/reinstatements from chargebacks
- `customer_links` — Customer profile linking (group_id based)
- `customer_link_rejections` — Rejected link suggestions (never re-offer)
- `coupon_mappings` — Shopify coupon → AI coupon mapping with VIP tiers
- `remedies` — Retention remedies per workspace (coupon, pause, skip, frequency_change, etc.)
- `remedy_outcomes` — Tracks every remedy offered/accepted/declined per cancel reason for learning
- `product_reviews` — Klaviyo-synced reviews with AI summaries for cancel journey social proof
- `payment_failures` — Per-attempt log: card tried, result, attempt type (initial/card_rotation/payday_retry/new_card_retry)
- `dunning_cycles` — Per-subscription per-billing-cycle dunning state (active/skipped/paused/recovered/exhausted)
- `email_events` — Universal email tracking (sent/delivered/opened/clicked/bounced) with resend_email_id join key
- `sonnet_prompts` — DB-driven prompt rules for Sonnet orchestrator (category: rule/approach/knowledge/tool_hint)
- `crisis_events` — Crisis campaigns (affected product, swap options, tiers, coupon)
- `crisis_customer_actions` — Per-customer crisis actions (tier responses, swaps, pause/remove, preserved_base_price_cents, exhausted_at)

## Ticket Tags (auto-applied for analytics)
When adding new journeys or workflows, always add the corresponding tag:
- `touched` — first outbound message sent (via `markFirstTouch()`)
- `ft:ai` / `ft:workflow` / `ft:journey` / `ft:agent` — who made first contact
- `j:{intent}` — journey applied (e.g., `j:discount_signup`, `j:cancel`, `j:return_request`)
- `jr:{intent}` — journey re-nudge sent (e.g., `jr:discount`)
- `w:{type}` — workflow applied (e.g., `w:tracking`, `w:cancel`, `w:subscription`)
- `ai:t{N}` — AI turn count, replaces on each turn (e.g., `ai:t1`, `ai:t2`)
- `agent` — a real human agent sent an external message
- `jo:positive` / `jo:negative` / `jo:neutral` — journey outcome (always ask the user what constitutes positive/negative/neutral for each new journey)
- `link` — customer linked accounts during a journey
- `dunning:active` — active dunning cycle on this ticket's customer
- `dunning:recovered` — payment recovered through dunning
- `dunning:skipped` — order was skipped due to payment failure
- `dunning:paused` — subscription paused due to repeated payment failure
- `pb` — playbook applied
- `pb:{slug}` — specific playbook (e.g., `pb:unwanted_charge_subscription_dispute`)
- `wb` / `wb:success` — subscription reactivated (win-back)
- `crisis` / `crisis:{id}` — crisis campaign ticket
- `crisis:test` — test crisis ticket
Use `addTicketTag()` from `src/lib/ticket-tags.ts` (idempotent). Use `markFirstTouch()` from `src/lib/first-touch.ts` for ft:* tags.

## Documentation Library
| File | Purpose |
|---|---|
| `CLAUDE.md` | This file — project overview, architecture, schema, conventions |
| `SONNET-ORCHESTRATOR.md` | Sonnet v2 tool-use architecture, data tools, action executor |
| `CANCEL-FLOW.md` | Cancel journey system — reasons, remedies, AI selection, execution |
| `JOURNEYS.md` | Journey system — builders, channels, delivery, step types |
| `CRISIS-MANAGEMENT-SPEC.md` | Crisis tool — tiers, swaps, price preservation, campaigns |
| `AGENTS.md` | Agent/model configuration |
| `PLAYBOOK-SPEC.md` | Playbook system — steps, policies, exceptions, stand-firm |
| `PLAYBOOK-PATTERNS.md` | Pattern matching for playbook triggers |
| `APPSTLE.md` | Appstle API reference — endpoints, auth, common operations |
| `DATABASE.md` | DB query reference — status case sensitivity, customer linking, common gotchas + recipes |
| `LOYALTY-SPEC.md` | Loyalty points, redemption tiers, coupon generation |
| `UNIFIED-HANDLER.md` | Unified ticket handler pipeline documentation |
| `TEXT-MARKETING.md` | SMS marketing — campaign builder, send pipeline, shortlinks, coupons, Klaviyo data pipeline, predictive segmentation, archetype framework |
| `PERPETUAL-CAMPAIGNS-SPEC.md` | Roadmap spec — shift from manual campaigns to archetype-driven series engine (daily qualifier + enrollment + multi-step send + sunset) |
| `APPSTLE-WEBHOOKS.md` | Reference for all Appstle webhook payloads (used by billing forecast + subscription state tracking) |

## Reseller Defense System (May 2026)

A multi-layer defense against people who buy from our store with coupons and resell on Amazon.

- **`known_resellers` table** — populated from Amazon SP-API. For every ASIN we sell, we list competitor offers, dedupe sellerIds, scrape each storefront page (`amazon.com/sp?seller=X`) for the registered business name + address, and upsert. New entries get `status='unverified'` (admin review before fraud rule activates).
- **Discovery** — one-shot via `npx tsx scripts/discover-resellers.ts`; weekly via `resellerDiscoveryWeeklyCron` (Mondays 6 AM CT).
- **Fraud rule `amazon_reseller`** — at order creation, compares ship+bill addresses against active resellers. Two-pass: (1) exact match on normalized form, (2) Haiku fuzzy match when zip + street number agree but text differs (catches obfuscated variants like "010083 Lynden Ova.l, Apt1"). On match: creates `fraud_cases` with `rule_type='amazon_reseller'`, `severity='high'`, `orders_held=true`. Logs to `fraud_action_log`.
- **Confirmed-fraud orchestrator gate** — In `unified-ticket-handler.ts` step 3.5, before Sonnet runs, we check `getCustomerFraudStatus()`. If the customer (or any linked profile) has any `fraud_cases.status='confirmed_fraud'`, the orchestrator is short-circuited: send `CONFIRMED_FRAUD_REPLY` ("We're sorry but your account has been flagged for potential fraud.") and close the ticket. No tools, no actions, no escalation.
- **Address fallback chain on order ingestion** (see `feedback_address_mirror_rule` memory):
  1. `Order.shippingAddress` and `Order.billingAddress` from Shopify GraphQL/webhook
  2. If only one populated → mirror into both columns
  3. If both null → fall back to `Customer.defaultAddress` via async Inngest job (`orders/address-fallback`)
- **Customer ban flag** — `customers.banned`, `banned_at`, `banned_reason`.
- **Operational scripts**:
  - `scripts/discover-resellers.ts` — populate `known_resellers`
  - `scripts/reseller-impact-report.ts` — find every order shipped to a reseller address + their active subs (output → `/tmp/reseller-impact-report.json`)
  - `scripts/cancel-and-ban-resellers.ts --dry-run | --confirm` — for each reseller in the report: cancel every active/paused sub via Appstle (`cancellationFeedback="fraud"`), ban every linked customer, flip related fraud_cases `open`/`reviewing` → `confirmed_fraud`
  - `scripts/backfill-1yr-addresses.ts` — backfill 365 days of orders missing ship/bill via the fallback chain

## Conventions
- Always run `npx tsc --noEmit` before committing to catch type errors
- Migrations: `supabase/migrations/YYYYMMDDNNNNNN_description.sql`
- API routes: `/api/resource/route.ts` or `/api/resource/[id]/route.ts`
- All API writes use admin client, auth verified via `createClient().auth.getUser()`
- Workspace scoped: always filter by workspace_id from cookie
- AI responses: plain text, max 2 sentences/paragraph, mirror customer language, no markdown
- User-facing names: always use `display_name` from workspace_members, never full name
- Journey mini-site and live chat must produce identical human-readable ticket messages
- Don't push during active Inngest syncs (deployment kills running functions)
- Use git worktrees for parallel feature development
- **Portal builds**: After any changes to `shopify-extension/portal-src/`, always run `node scripts/build-all-portals.js` before committing. This builds both the Shopify extension portal and the mini-site portal from the same source files.
- **Customer-referenced tables**: When creating a new table with a `customer_id` column, add a corresponding data tool in `src/lib/sonnet-orchestrator-v2.ts` so the Sonnet orchestrator can access it. See `SONNET-ORCHESTRATOR.md` for instructions.
- **Journeys**: Each journey has ONE builder file as source of truth. `journey-step-builder.ts` delegates via async import. All data from database, never hardcoded. See `JOURNEYS.md`.
- **Cancel flow**: Cancel reasons and remedies come from Settings → Cancel Flow (database only). See `CANCEL-FLOW.md`.
