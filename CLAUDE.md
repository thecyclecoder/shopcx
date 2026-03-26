@AGENTS.md

# ShopCX.ai — The Retention Operating System

## Project Overview
ShopCX.ai replaces Gorgias (helpdesk), Siena AI (customer service AI), Appstle (subscriptions), and Klaviyo (email/SMS marketing + reviews) with a unified platform. Internal-first for Superfoods Company, multi-tenant SaaS architecture from day one.

- **Domain**: https://shopcx.ai
- **GitHub**: https://github.com/thecyclecoder/shopcx
- **Vercel**: dylan-ralstons-projects/shopcx (Pro plan, Next.js framework)
- **Supabase**: project ref `urjbhjbygyxffrfkarqn` (Superfoods Company org)
- **Inngest**: 2 functions registered (sync-shopify, ticket-csat)
- **Product Spec**: `shopcx-product-spec.html` (9 phases, ~20-22 weeks)

## Tech Stack
- **Frontend**: Next.js 16 (App Router), Tailwind CSS, TypeScript
- **Backend**: Supabase (Postgres + RLS), Vercel serverless
- **Background Jobs**: Inngest (durable steps, retries, concurrency control)
- **Email**: Resend (sending + inbound via webhook)
- **Integrations**: Shopify (GraphQL + REST + Bulk Operations + webhooks)
- **Encryption**: AES-256-GCM for all stored API keys/tokens

## Architecture Decisions
- **RLS on every table**: workspace_id column, authenticated users get SELECT, service_role gets ALL
- **Admin client pattern**: All writes go through `createAdminClient()` (service_role), never client-side
- **JWT custom hook**: `custom_access_token_hook` injects workspace_id + workspace_role into JWT
- **Workspace context**: Cookie-based (`workspace_id`), resolved in middleware, available via `useWorkspace()` hook
- **Per-workspace credentials**: Shopify, Resend, etc. keys stored encrypted per workspace, not in env vars
- **Sandbox mode**: Default on. Forwarded support email tickets don't get real replies until sandbox is off. Direct inbound@ tickets always work.

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
  - Captures: email, name, phone, orders count, LTV, subscription status (productSubscriberStatus), tags
  - Phone-only customers synced as {phone}@phone.local
  - Skip customers with no email AND no phone
  - Skip sync if DB count matches Shopify (within 1%)
- Order sync via Shopify GraphQL Bulk Operations
  - Captures: order details, line items, source_name, tags
  - Known app IDs mapped to friendly names (Facebook & Instagram, etc.)
- Retention Score v1 (0-100):
  - Purchase recency 30%, frequency 25%, LTV 25%, subscription status 20%
- Inngest-powered background sync:
  - Bulk ops: start → poll (each poll is a step) → download JSONL → batch upsert
  - Progress bar with real-time updates (polls sync_jobs table every 3s)
  - Stale job detection (auto-fail after 15 min)
  - fetchWithRetry on all Shopify API calls (3x with backoff)
- Shopify webhooks: customers/create, customers/update, orders/create, orders/updated
  - Customer webhooks enriched with productSubscriberStatus via GraphQL
- Order source mapping UI (Settings > Integrations > Shopify)
- Customer list page: search (Enter to submit), sortable columns, retention badges, pagination
- Customer detail page: stats, order history, retention score

### Phase 3: Ticketing ✅
- Tickets + ticket_messages tables with RLS
- Email inbound: Resend webhook → fetch body → create ticket
- Email outbound: Agent replies via Resend with In-Reply-To threading
- Email threading: In-Reply-To → message ID → subject + sender fallback
- Statuses: open, pending, closed (resolved removed)
- Auto-transitions: agent reply → pending, customer reply → reopen
- Close with reply: checkbox on composer, closes ticket on send
- CSAT: Inngest sends survey 24hrs after closed, HMAC-signed rating page
- Sandbox mode, multiple support emails, MX record check
- Rich text reply composer with formatting toolbar (bold, italic, lists, links)
- Expandable editor: collapsed single-line, expands on focus with toolbar
- Ticket detail polls every 10s for new messages + status updates
- Ticket queue: auto-refreshes every 10s, filterable by status/channel/assignee/tags
- Multi-select tag filtering on ticket queue
- Quoted reply stripping on inbound messages
- Customer sidebar: orders, subscriptions, LTV, retention score (live computed)
- Lazy customer enrichment from Shopify on page view
- last_customer_reply_at tracking, Created + Last Reply columns
- Delete ticket: owner/admin only with confirmation dialog
- Sidebar counts poll every 10s for live updates

### Phase 3b: Rules Engine ✅
- Rules table: compound AND/OR conditions (JSONB), ordered actions, priority
- 8 action types: add/remove tags, set status, assign, auto-reply, internal note, update customer, Appstle subscription actions
- Synchronous evaluation in all 6 event sources (email, ticket changes, Shopify, Appstle webhooks)
- Template variables in auto-replies: {{customer.first_name}}, {{ticket.subject}}, etc.
- Rule builder UI in Settings > Rules

### Phase 3c: Ticket Views ✅
- Saved views with nested hierarchy (2 levels deep)
- Collapsible in sidebar with ▸/▾ toggle
- Per-view ticket counts (capped at 99+)
- Filter combos: status, channel, assigned to, tag (multi-select), search
- Save as View from active filters
- View editor in Settings > Ticket Views
- Built-in Escalations submenu (personal: escalated to/by me)

### Phase 3d: Escalation ✅
- Separate escalation layer: escalated_to, escalated_at, escalation_reason
- Independent from assignment (ticket stays with agent)
- Amber flag on ticket list + sidebar dropdown
- Personal escalation views in sidebar with counts
- Workflow escalation: customer reply + person selector + status

### Phase 3e: Smart Patterns ✅
- Global pattern library: 9 categories, 220+ phrases (seeded from ticket analysis)
- 3-layer classifier: keywords (instant) → pgvector embeddings (semantic) → Claude Haiku (fallback)
- Auto-tags tickets on ingest with smart: prefix (violet badges)
- Workspace-specific patterns + global pattern overrides (enable/dismiss)
- AI pattern suggestion: Claude analyzes tickets, suggests phrases + category
- Smart tag feedback loop: agent removal → AI analysis → admin review queue
- Pattern review banner notification for admins
- Settings > Smart Patterns: global library + workspace patterns + review queue

### Phase 3f: Workflows ✅
- 3 template workflows: Order Tracking, Cancel Request, Subscription Inquiry
- Shopify fulfillment data: carrier events, delivered/in-transit/out-for-delivery, shipping address
- 24 template variables (customer, order, fulfillment, subscription)
- Rich text reply templates with formatting
- Per-channel response delays (Inngest step.sleep): email 60s, chat 5s, sms 10s
- Cancel auto-reply button on ticket detail
- Pending auto-reply preview in conversation (purple ghost message with resolved variables)
- Manual workflow trigger from ticket detail dropdown
- Configurable status per reply step (pending/closed/open)
- Positive confirmation detection + delayed auto-close
- Configurable auto-close reply message (Settings > Auto-Close Reply)
- Response delay settings per channel (Settings > Response Delay)
- auto_reply_at timestamp + pending_auto_reply preview on tickets
- Workflow preview resolves actual variables via full context build (Shopify API)
- Delivery address from Shopify order shippingAddress (not customer default)
- Rich text editors in workflow reply templates

### Phase 3g: Customer Identity ✅
- Customer linking across profiles (email, phone, name, address matching)
- Combined orders, subscriptions, tickets across linked profiles
- Ticket sidebar uses linked data for LTV/order count/retention score
- Customer merge on Shopify webhook (email-only → Shopify customer)
- Suggestions API: auto-detects potential matches
- Tickets list on customer detail page (combined across linked profiles)
- Retention score + LTV + order count computed live on both customer detail and ticket sidebar
- Customer linking fix: is_primary NOT NULL constraint resolved
- Linked profile banner (pending — show "linked to [Primary]" on secondary profiles)

## Pending Items
- Linked profile banner on secondary customer profiles ("This profile is linked to [Primary]")
- Account linking UI on ticket detail sidebar
- Nightly pattern analyzer (Inngest cron: analyze untagged tickets, suggest patterns)
- OpenAI embeddings fully operational (key added, embeddings generated, threshold tuned to 0.40)

## Remaining Phases (from spec)
- **Phase 4**: AI Agent + Knowledge Base (foundation built: patterns, workflows, Claude integration)
- **Phase 5**: Live Chat Widget (embeddable JS, WebSocket via Supabase Realtime)
- **Phase 6**: Meta Social Command Center (Graph API, comment queues, moderation)
- **Phase 7**: Native Subscription Manager (Appstle migration, dunning flows)
- **Phase 8**: Behavioral Tracking SDK (JS SDK, customer timeline, at-risk dashboard)
- **Phase 9**: Email & SMS Marketing (Resend + Twilio, segments, flows, campaigns)

## Future Roadmap (beyond spec)
- **Reviews System**: Replace Klaviyo Reviews. Proactive review requests for high-order customers who haven't reviewed yet.
- **Help Center**: Replace Gorgias help center. Import existing docs, link to Shopify products, public subdomain (help.superfoodscompany.com), AI integration for Phase 4.

## Key Files
- `src/lib/supabase/admin.ts` — Service role client for all DB writes
- `src/lib/supabase/server.ts` — SSR client for auth checks
- `src/lib/supabase/middleware.ts` — Auth + workspace + sandbox enforcement
- `src/lib/crypto.ts` — AES-256-GCM encrypt/decrypt for API keys
- `src/lib/shopify-sync.ts` — Bulk ops, paginated sync, per-batch customer lookups, rate limit guard
- `src/lib/shopify-webhooks.ts` — Customer/order webhook handlers, customer merge logic
- `src/lib/inngest/sync-shopify.ts` — Order/customer sync with memoized steps
- `src/lib/inngest/import-subscriptions.ts` — 6-function fan-out import pipeline
- `src/lib/inngest/workflow-delayed.ts` — Delayed workflow execution + positive-close
- `src/lib/inngest/ticket-csat.ts` — CSAT survey 24hrs after ticket close
- `src/lib/rules-engine.ts` — Synchronous rule evaluation with compound AND/OR conditions
- `src/lib/rules-actions.ts` — 8 action executors (tag, status, assign, reply, note, customer, appstle)
- `src/lib/pattern-matcher.ts` — 3-layer classifier: keywords → embeddings → Claude Haiku
- `src/lib/workflow-executor.ts` — Template workflows with Shopify fulfillment data + 24 variables
- `src/lib/embeddings.ts` — Multi-provider embedding generation (OpenAI, Voyage, HuggingFace)
- `src/lib/appstle.ts` — Appstle API helper (pause/cancel/resume subscriptions)
- `src/lib/email.ts` — Resend client, send ticket reply, send CSAT, send invite
- `src/lib/email-utils.ts` — Quoted reply stripping
- `src/lib/retention-score.ts` — Retention score calculation + batch update
- `src/lib/workspace.ts` — Workspace resolution, PWA fallback, auto-accept invites
- `src/lib/stores/import-store.ts` — Zustand store for import progress (localStorage)

## Environment Variables (Vercel Production)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — Admin operations
- `NEXT_PUBLIC_SITE_URL` — https://shopcx.ai
- `NEXTAUTH_URL` — https://shopcx.ai
- `ENCRYPTION_KEY` — 64-char hex for AES-256-GCM
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Inngest auth
- `ANTHROPIC_API_KEY` — Claude API for pattern suggestions + Haiku classification
- `OPENAI_API_KEY` — Embeddings via text-embedding-3-small (384 dims)

## Database Schema (Supabase)
- `workspaces` — Multi-tenant root. Credentials (encrypted), sandbox_mode, response_delays, auto_close_reply
- `workspace_members` — User ↔ workspace with role enum
- `workspace_invites` — Email-based invites with expiry
- `support_emails` — Multiple support addresses per workspace with labels
- `customers` — Synced from Shopify. Email, retention_score, subscription_status, LTV, tags, shopify_customer_id
- `customer_links` — Link profiles across emails (group_id, is_primary)
- `orders` — Synced from Shopify. shopify_customer_id, subscription_id, source_name, order_type, fulfillments JSONB
- `subscriptions` — From Appstle CSV import + webhooks. Items JSONB, consecutive_skips
- `tickets` — Status (open/pending/closed), tags TEXT[], escalated_to, auto_reply_at, pending_auto_reply, last_customer_reply_at
- `ticket_messages` — Direction, visibility, author_type, email threading
- `ticket_views` — Saved filter combos with parent_id for nesting
- `sync_jobs` — Track Shopify sync progress
- `import_jobs` — Track CSV import progress (6-step pipeline)
- `rules` — Compound AND/OR conditions, ordered actions, priority, stop_processing
- `smart_patterns` — Global + workspace patterns, phrases JSONB, embedding vector(384), auto_tag
- `workspace_pattern_overrides` — Enable/dismiss globals per workspace
- `pattern_feedback` — Agent feedback on smart tag removal + AI analysis
- `workflows` — Template-based (order_tracking, cancel_request, subscription_inquiry), config JSONB

## Conventions
- Migrations: `supabase/migrations/YYYYMMDDNNNNNN_description.sql`
- API routes: `/api/resource/route.ts` or `/api/resource/[id]/route.ts`
- All API writes use admin client, auth verified via `createClient().auth.getUser()`
- Workspace scoped: always filter by workspace_id from cookie
- Don't push during active Inngest syncs (deployment kills running functions)
