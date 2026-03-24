@AGENTS.md

# ShopCX.AI — The Retention Operating System

## Project Overview
ShopCX.AI replaces Gorgias (helpdesk), Siena AI (customer service AI), Appstle (subscriptions), and Klaviyo (email/SMS marketing + reviews) with a unified platform. Internal-first for Superfoods Company, multi-tenant SaaS architecture from day one.

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

### Phase 3: Basic Ticketing ✅
- Tickets + ticket_messages tables with RLS
- Email inbound: Resend webhook → fetch body via /emails/receiving/{id} → create ticket
- Email outbound: Agent replies sent via Resend with In-Reply-To threading
- Email threading: In-Reply-To header match → message ID match → subject + sender fallback
- Auto-transitions: agent reply → open→pending, customer reply → reopen pending/resolved
- CSAT: Inngest sends survey 24hrs after ticket closed, HMAC-signed public rating page
- Sandbox mode: forwarded support email tickets don't send real replies until disabled
- Multiple support email addresses with labels (contact@, hello@, returns@, etc.)
- Inbound email webhook auto-setup via Resend API
- MX record check with Google DNS propagation status
- Email signature stripping (Gmail, Outlook, Apple, RFC --) for display
- Quoted reply stripping for display
- Ticket queue: auto-refreshes every 10s, filterable by status/channel/assignee
- Ticket detail: conversation thread, reply composer (Reply vs Note), customer sidebar
- Integrations pages gated to owner/admin roles

## Remaining Phases (from spec)
- **Phase 4**: AI Agent + Knowledge Base (Claude API, RAG with pgvector, confidence scoring)
- **Phase 5**: Live Chat Widget (embeddable JS, WebSocket via Supabase Realtime)
- **Phase 6**: Meta Social Command Center (Graph API, comment queues, moderation)
- **Phase 7**: Native Subscription Manager (Stripe Billing, dunning, Appstle migration)
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
- `src/lib/shopify-sync.ts` — Bulk ops, paginated sync, counts, customer/order processing
- `src/lib/shopify-webhooks.ts` — Customer/order webhook handlers with GraphQL enrichment
- `src/lib/inngest/sync-shopify.ts` — Inngest function: skip/bulk/paginated strategy
- `src/lib/inngest/ticket-csat.ts` — CSAT survey 24hrs after ticket close
- `src/lib/email.ts` — Resend client, send ticket reply, send CSAT, send invite
- `src/lib/email-utils.ts` — Signature + quoted reply stripping
- `src/lib/retention-score.ts` — Retention score calculation + batch update
- `src/lib/access.ts` — Admin email + invite-based access gate
- `src/lib/workspace.ts` — Workspace resolution, active workspace, auto-accept invites

## Environment Variables (Vercel Production)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — Admin operations
- `NEXT_PUBLIC_SITE_URL` — https://shopcx.ai
- `NEXTAUTH_URL` — https://shopcx.ai
- `ENCRYPTION_KEY` — 64-char hex for AES-256-GCM
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Inngest auth

## Database Schema (Supabase)
- `workspaces` — Multi-tenant root. Plan, Shopify/Resend/Stripe credentials (encrypted), sandbox_mode, order_source_mapping
- `workspace_members` — User ↔ workspace with role enum
- `workspace_invites` — Email-based invites with expiry
- `support_emails` — Multiple support addresses per workspace with labels
- `customers` — Synced from Shopify. Email (or phone.local), retention_score, subscription_status, LTV, tags
- `orders` — Synced from Shopify. Linked to customers, source_name, line_items JSONB, order_type
- `tickets` — Channel, status workflow, assignment, CSAT, email_message_id for threading
- `ticket_messages` — Direction, visibility, author_type, email threading
- `sync_jobs` — Track sync progress for frontend polling

## Conventions
- Migrations: `supabase/migrations/YYYYMMDDNNNNNN_description.sql`
- API routes: `/api/resource/route.ts` or `/api/resource/[id]/route.ts`
- All API writes use admin client, auth verified via `createClient().auth.getUser()`
- Workspace scoped: always filter by workspace_id from cookie
- Don't push during active Inngest syncs (deployment kills running functions)
