# Meta Comments Moderation

A first-class moderation surface for Facebook + Instagram comments on Page posts, separate from the ticketing system. Comments are not customer support tickets — they're a public moderation surface — so they get their own data model, dashboard menu item, and AI behavior.

Social **DMs** stay in tickets (channel = `meta_dm`) because they're real one-to-one customer conversations that need the full ticket sidebar (orders, subs, journeys). Social **comments** move out of tickets entirely.

## Why this is its own thing

| Tickets | Social comments |
|---|---|
| Private 1:1 conversation | Public, anyone can see |
| Customer is almost always known (email/phone) | Commenter is anonymous to us — only a Meta user ID |
| Resolution = solve a problem | Resolution = reply / hide / delete / ban |
| Sidebar shows orders, subs, retention | Sidebar shows post context, ad/organic flag, page type |
| Routes through journeys, playbooks, workflows | Routes through one decision tool: reply / hide / delete / ignore |
| Tied to retention metrics | Tied to brand-safety metrics |

Trying to model both in `tickets` would force every comment to look like a half-built ticket and clutter the queue agents use for real support work. A dedicated table fixes that.

## What already exists

The repo has substantial Meta integration plumbing we will reuse — almost all of the Graph API surface is in place:

| Asset | Location | Reuse |
|---|---|---|
| Meta OAuth flow + callback | `src/app/api/meta/auth/route.ts`, `src/app/api/meta/callback/route.ts` | Yes, extended for multi-page |
| Page Access Token storage | `workspaces.meta_page_access_token_encrypted` (single page) | Extend to a `meta_pages` table for multi-page |
| Webhook endpoint | `src/app/api/webhooks/meta/route.ts` | Route comment events to new table, keep DM events on tickets |
| `replyToComment`, `hideComment`, `deleteComment` | `src/lib/meta.ts` | Direct reuse |
| `subscribePageWebhooks` | `src/lib/meta.ts` (subs to `messages`, `feed`, `mention`) | Direct reuse |
| `social_comments` ticket channel | `tickets.channel` constraint | **Retire** after migration |
| Encrypted credential pattern | `src/lib/crypto.ts` (AES-256-GCM) | Direct reuse |
| Sonnet orchestrator v2 + tool-use | `src/lib/sonnet-orchestrator-v2.ts` | Reuse for AI moderation decisions |

### What needs adding

1. **HMAC signature verification** on the Meta webhook (currently missing — security gap that must close before launch).
2. **Multi-page support** — `meta_pages` table with one row per Page or IG Business account, `page_type` enum, `ai_moderation_policy`, per-page Page Access Token.
3. **`social_comments` table** — the moderation surface itself (separate from tickets).
4. **`social_comment_replies` table** — thread of replies on each comment (inbound nested replies from users + outbound replies we send).
5. **`banned_meta_users` table** — workspace-level ban list with timestamp + reason.
6. **`meta_post_cache` table** — denormalized post metadata (URL, image, body, ad/organic flag, ad ID) so comment views don't have to round-trip to Graph API on every render.
7. **Comment liking** — `likeComment(commentId)` helper (Graph API: `POST /{comment-id}/likes`). Not currently implemented.
8. **`unbanMetaUser`** — undo action.
9. **Dashboard surface** — sidebar menu item, list view, detail view (conversation window + moderation sidebar).
10. **AI moderation flow** — Sonnet decides per-comment: `reply` / `hide` / `delete` / `like` / `ignore` / `escalate`. Governed by per-page moderation policy.
11. **Product matching** — parse URLs in post body and ad creative, match to `products.handle` from path segments.
12. **Migration** — existing `tickets` with channel `social_comments` get migrated into the new `social_comments` table and removed from the ticket queue.

## Architecture

```
Meta webhook (POST /api/webhooks/meta)
    │
    ├──▶ HMAC verify (X-Hub-Signature-256)
    │
    ├── object = "page" + field = "messages"   ──▶ existing DM → tickets flow (unchanged)
    │
    └── object = "page"/"instagram" + field = "feed"/"comments"
            │
            ▼
        Resolve meta_pages row from page_id/ig_id
            │
            ▼
        Insert social_comments row
            │
            ▼
        Should we moderate this comment?
            │
            ├── Brand page  ──▶ moderate ad + organic
            ├── Creator page ──▶ moderate ad only (skip organic)
            └── Banned user  ──▶ auto-hide, no AI
                │
                ▼
            Inngest: social_comment.created
                │
                ▼
            Sonnet decides: reply / hide / delete / like / ignore / escalate
                │
                ▼
            action-executor fires the chosen Graph API call
                │
                ▼
            social_comments.status + moderation_status updated
            social_comment_replies row written (for replies)
```

## Data model

### `meta_pages`
One row per Facebook Page or Instagram Business account we have a token for. Replaces the single-page columns on `workspaces`.

```sql
CREATE TABLE meta_pages (
  id                          UUID PK,
  workspace_id                UUID FK → workspaces,
  platform                    TEXT NOT NULL,           -- 'facebook' | 'instagram'
  meta_page_id                TEXT NOT NULL,           -- FB Page ID or IG Business Account ID
  meta_page_name              TEXT,
  page_type                   TEXT NOT NULL DEFAULT 'brand',  -- 'brand' | 'creator'
  ai_moderate_ad_comments     BOOLEAN NOT NULL DEFAULT true,
  ai_moderate_organic_comments BOOLEAN NOT NULL DEFAULT true,
  access_token_encrypted      TEXT NOT NULL,           -- per-page long-lived token
  webhook_verify_token        TEXT,
  is_active                   BOOLEAN DEFAULT true,
  connected_at                TIMESTAMPTZ DEFAULT now(),
  last_synced_at              TIMESTAMPTZ,
  created_at, updated_at,
  UNIQUE(workspace_id, meta_page_id)
);
```

**Default policy by page_type:**
- `brand` → moderate both (ad + organic)
- `creator` → moderate ad only, organic stays untouched

Admins can override per-page in settings.

### `social_comments`
The moderation queue itself. One row per Meta comment that fires the webhook.

```sql
CREATE TABLE social_comments (
  id                  UUID PK,
  workspace_id        UUID FK,
  meta_page_id        UUID FK → meta_pages,

  -- Meta identifiers
  meta_comment_id     TEXT NOT NULL,                 -- Meta's comment ID
  meta_parent_comment_id TEXT,                       -- if this is a reply to another comment
  meta_post_id        TEXT NOT NULL,                 -- parent post
  meta_sender_id      TEXT NOT NULL,                 -- commenter's Meta user ID
  meta_sender_name    TEXT,
  meta_sender_username TEXT,                         -- IG username if available

  body                TEXT NOT NULL,

  -- Classification
  is_ad               BOOLEAN NOT NULL DEFAULT false,
  page_type           TEXT NOT NULL,                 -- denormalized from meta_pages
  ad_id               TEXT,                          -- if is_ad, the ad creative ID
  sentiment           TEXT,                          -- 'positive' | 'negative' | 'neutral' | 'spam' | 'abusive' | null
  matched_product_id  UUID FK → products,            -- from URL extraction on the parent post

  -- Moderation state
  status              TEXT NOT NULL DEFAULT 'open',
                      -- 'open' | 'replied' | 'hidden' | 'deleted' | 'ignored' | 'escalated'
  moderation_source   TEXT,
                      -- 'ai_auto' | 'ai_suggested' | 'agent_manual' | 'rule' | null
  assigned_to         UUID FK → users,               -- when escalated to an agent

  -- Audit
  hidden_at           TIMESTAMPTZ,
  hidden_by           UUID,
  deleted_at          TIMESTAMPTZ,
  deleted_by          UUID,
  replied_at          TIMESTAMPTZ,
  replied_by          UUID,                          -- null = AI

  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),

  UNIQUE(workspace_id, meta_comment_id)
);

CREATE INDEX social_comments_workspace_status_idx ON social_comments (workspace_id, status, created_at DESC);
CREATE INDEX social_comments_page_idx ON social_comments (meta_page_id, created_at DESC);
CREATE INDEX social_comments_sender_idx ON social_comments (meta_sender_id);
CREATE INDEX social_comments_product_idx ON social_comments (matched_product_id) WHERE matched_product_id IS NOT NULL;
```

### `social_comment_replies`
Conversation thread per comment. Every inbound nested reply and every outbound reply we send.

```sql
CREATE TABLE social_comment_replies (
  id                  UUID PK,
  workspace_id        UUID FK,
  social_comment_id   UUID FK → social_comments ON DELETE CASCADE,

  meta_reply_id       TEXT NOT NULL,                  -- Meta's ID for the reply
  meta_sender_id      TEXT,                           -- null if it's our reply
  meta_sender_name    TEXT,

  direction           TEXT NOT NULL,                  -- 'inbound' | 'outbound'
  author_type         TEXT NOT NULL,                  -- 'customer' | 'agent' | 'ai' | 'system'
  author_user_id      UUID,                           -- agent who replied, if applicable

  body                TEXT NOT NULL,

  -- For outbound: tracks whether the Graph API call succeeded
  send_status         TEXT,                           -- 'pending' | 'sent' | 'failed'
  send_error          TEXT,

  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, meta_reply_id)
);

CREATE INDEX social_comment_replies_comment_idx ON social_comment_replies (social_comment_id, created_at);
```

### `banned_meta_users`
Workspace-wide ban list. Banning a user auto-hides all their existing comments and auto-hides any future comment.

```sql
CREATE TABLE banned_meta_users (
  id              UUID PK,
  workspace_id    UUID FK,
  meta_sender_id  TEXT NOT NULL,
  sender_name     TEXT,
  sender_username TEXT,
  reason          TEXT,
  banned_by       UUID FK → users,
  banned_at       TIMESTAMPTZ DEFAULT now(),
  unbanned_at     TIMESTAMPTZ,
  unbanned_by     UUID,
  UNIQUE(workspace_id, meta_sender_id)
);

CREATE INDEX banned_meta_users_workspace_active_idx
  ON banned_meta_users (workspace_id, meta_sender_id) WHERE unbanned_at IS NULL;
```

### `meta_post_cache`
Denormalized post metadata so the comment list/detail UIs don't round-trip to Graph API on every render. Refreshed on first comment for a post + on demand.

```sql
CREATE TABLE meta_post_cache (
  id                  UUID PK,
  workspace_id        UUID FK,
  meta_page_id        UUID FK → meta_pages,

  meta_post_id        TEXT NOT NULL,
  is_ad               BOOLEAN NOT NULL DEFAULT false,
  ad_id               TEXT,
  permalink_url       TEXT,
  message             TEXT,                 -- post caption / body
  image_url           TEXT,
  video_url           TEXT,
  posted_at           TIMESTAMPTZ,

  -- Extracted from message + caption — used for product matching
  extracted_urls      TEXT[] DEFAULT '{}',
  matched_product_id  UUID FK → products,

  last_refreshed_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, meta_post_id)
);
```

## Webhook handling

`POST /api/webhooks/meta` is the single ingestion point. We extend it:

1. **HMAC verify** — read `X-Hub-Signature-256` header. Compute `sha256=HMAC-SHA256(METAaPP_SECRET, raw_body)` and constant-time compare. Reject 401 on mismatch. **This is a security fix that must ship before this feature.**
2. **Route by object/field**:
   - `field === "messages"` → existing DM flow (creates a ticket in `meta_dm` channel) — unchanged.
   - `field === "feed"` AND `value.item === "comment"` (Facebook) → comment flow.
   - `field === "comments"` (Instagram) → comment flow.
   - `verb === "add"` → insert new `social_comments` row.
   - `verb === "edited"` → update existing row's body, mark `edited_at`.
   - `verb === "remove"` (Meta-side deletion by user) → set status = 'deleted', mark `deleted_by_user_at`.
3. **Insert / classify**:
   - Resolve `meta_pages` row by `entry[i].id` (page ID).
   - Determine `is_ad`: if `value.ad_id` present OR the parent post is in `meta_post_cache` with `is_ad=true`, mark `is_ad=true`. Cache the post if first time seen (call `GET /{post-id}?fields=permalink_url,message,attachments,is_eligible_for_promotion`).
   - Insert `social_comments` row.
4. **Check ban list** before AI moderation:
   - If `meta_sender_id` is in `banned_meta_users` (active) → fire `hideComment` action immediately, set status='hidden', `moderation_source='rule'`. Skip Sonnet.
5. **Check moderation policy**:
   - `meta_pages.ai_moderate_ad_comments` and `ai_moderate_organic_comments` decide whether to even ask Sonnet.
   - If both false for this comment's classification → leave status='open' (manual moderation only).
6. **Fire Inngest event** `social/comment.created` with `social_comment_id` so the moderation handler can run async.

## Product matching from post

When a comment fires on a post for the first time, the webhook handler calls `GET /{post-id}?fields=permalink_url,message,attachments{media,target,subattachments}` to fetch the post and:

1. Parses all URLs from `message` (regex `https?://[^\s]+`).
2. Parses URLs from `attachments[].target.url` (link click destination on ads).
3. For each URL:
   - If host matches our storefront domain → extract the path (e.g. `/amazing-coffee`), strip query, match to `products.handle`.
   - If host is `linktr.ee`, `lnk.bio`, or other known link aggregator → follow the redirect (one hop, 5s timeout) and try again.
   - If host is a known shortlink service (bit.ly, sprfd.co once built) → follow redirect.
4. First match wins. Store on `meta_post_cache.matched_product_id` + denormalize to `social_comments.matched_product_id`.
5. If no URL matches, leave null. Admin can manually assign a product on the comment detail view.

The product context flows into Sonnet's moderation decision so it knows "this comment is on a Cocoa Coffee ad" and can answer ingredient/flavor questions or detect product complaints.

## Sonnet moderation flow

The orchestrator runs once per comment via a dedicated Inngest handler (`src/lib/inngest/social-comment-moderate.ts`). Same Sonnet v2 architecture as the ticket orchestrator, but with a different tool catalog and decision schema.

### Pre-context (~200 tokens)
- Comment body
- Sender name / username
- Page name + page_type (brand/creator)
- Post context: URL, caption (first 200 chars), is_ad
- Matched product (title + tagline if any)
- Past comment history from same sender on this workspace (count + last_status)

### On-demand tools
- `get_product_knowledge` (existing — reuse from orchestrator v2)
- `get_brand_policies` — community guidelines, banned topics, escalation triggers (DB-driven prompts in `social_moderation_prompts`)
- `get_sender_history` — past comments from this sender in this workspace (sentiment, statuses)

### Decision schema
```json
{
  "reasoning": "brief explanation",
  "action": "reply" | "hide" | "delete" | "like" | "ignore" | "escalate",
  "reply_body": "string or null",
  "sentiment": "positive | negative | neutral | spam | abusive",
  "ban_user": false,
  "ban_reason": null
}
```

### Action mapping
| Action | What fires |
|---|---|
| `reply` | `replyToComment(pageToken, comment_id, reply_body)` → insert `social_comment_replies` outbound row → set comment status='replied' |
| `like` | `likeComment(pageToken, comment_id)` → set `liked_at` |
| `hide` | `hideComment(pageToken, comment_id, true)` → set status='hidden' |
| `delete` | `deleteComment(pageToken, comment_id)` → set status='deleted' |
| `ignore` | No Graph API call. Status stays 'open' but `moderation_status='ai_ignored'` so it doesn't sit in the agent queue |
| `escalate` | Status='escalated', `assigned_to=<round-robin agent>`, dashboard notification |
| `ban_user=true` | Add to `banned_meta_users`, then auto-hide all existing comments from this sender |

### When NOT to moderate
- Page's policy disables moderation for this comment's classification
- Sender is in `banned_meta_users` (we hide immediately, no Sonnet needed)
- Comment was posted by the page itself (we never moderate ourselves)
- Sender is a known business partner / employee / influencer (configurable `whitelisted_meta_users` table — *post-MVP*)

## Dashboard UI

Sidebar (under Tickets, but a sibling menu item not a sub-item):
```
Tickets
  All open
  …
Social Comments     ← new
  Open
  Hidden
  Escalated
  Banned users
```

### List view (`/dashboard/social-comments`)
Table columns:
- Page (with type badge: brand/creator)
- Post (thumbnail + first 60 chars of caption + ad/organic badge + product chip if matched)
- Commenter (name, username)
- Comment body (truncated to 200 chars)
- Sentiment chip
- Status chip
- Action timestamp
- Quick actions: Reply / Hide / Delete / Like / Ban (icons inline)

Filters:
- Page
- Page type (brand / creator)
- Status (open / hidden / replied / deleted / escalated)
- Sentiment
- Product
- Date range
- Ad vs organic

### Detail view (`/dashboard/social-comments/[id]`)
**Center column** — conversation thread reusing the ticket message layout:
- Original comment as the first message
- Any nested replies (inbound from users + outbound from us) below it, threaded
- Reply composer at the bottom (rich text minimal — Meta strips formatting)
- "Apply & Send" button (or "Approve & Send" if sandbox)

**Right sidebar** — moderation-focused, NOT customer-focused:
- **Post context card**: thumbnail, "View on Facebook/Instagram" link, ad/organic badge, ad ID if applicable, posted date, page name + type
- **Product card** (if matched): product title, image, link to product page
- **Sender card**: name, username, comment count from this sender (with link to "View all comments by this user"), banned status indicator
- **AI suggestion card** (if Sonnet ran): reasoning + suggested action + "Apply" button
- **Moderation actions**: Reply / Like / Hide / Delete / Ban User (each with confirm dialog where appropriate)
- **Audit log**: who did what when

NO orders, NO subscriptions, NO retention score, NO journeys, NO playbooks. This is a moderation surface, not a CX surface.

### Banned users page (`/dashboard/social-comments/banned`)
- List of `banned_meta_users` (active)
- Per row: name, username, banned at, banned by, reason, comment count
- Actions: Unban, View their comments

## Sandbox mode

Same pattern as tickets: when `workspaces.sandbox_mode = true`, AI moderation decisions are surfaced as suggestions only. They appear in the AI suggestion card with an "Apply & Send" button. Nothing fires against Meta until an agent approves.

## Migration

One-shot migration script:
1. Read all tickets with `channel = 'social_comments'`.
2. For each, create a `social_comments` row + insert the original message + any agent replies as `social_comment_replies` rows.
3. Use the ticket's `meta_comment_id`, `meta_post_id`, `meta_sender_id` for the comment IDs.
4. Soft-delete the original tickets (`status = 'archived'` or similar) with an `archived_reason = 'migrated_to_social_comments'`.
5. Remove `social_comments` from the `tickets.channel` constraint **after** migration.
6. Update the webhook to route new comment events to the new table, never to tickets.

The new `meta_pages` table needs backfill too:
1. For every workspace with `meta_page_access_token_encrypted` set, insert one `meta_pages` row with the existing values + `page_type = 'brand'` (admins can change after).

## Build order

1. **Migration** — `meta_pages`, `social_comments`, `social_comment_replies`, `banned_meta_users`, `meta_post_cache`. One PR.
2. **Webhook HMAC verification** — security gap close, ship before anything else (this is current production exposure).
3. **Multi-page settings UI** — extend `/dashboard/settings/integrations/meta` to manage multiple pages with `page_type` per page.
4. **Webhook routing** — comment events go to new tables, DM events keep going to tickets.
5. **Product matching helper** — `src/lib/meta-product-match.ts` with URL → product.handle resolution.
6. **Sonnet moderation orchestrator** — `src/lib/inngest/social-comment-moderate.ts` + the moderation prompts table.
7. **Action helpers** — extend `src/lib/meta.ts` with `likeComment`. Reuse existing reply/hide/delete.
8. **Dashboard list view** — `/dashboard/social-comments`.
9. **Dashboard detail view** — `/dashboard/social-comments/[id]` with thread + moderation sidebar.
10. **Ban list page** — `/dashboard/social-comments/banned`.
11. **Migration script** — move existing `social_comments`-channel tickets into the new table.
12. **Retire `social_comments` from `tickets.channel`** constraint.

## Key files (target)

| File | Purpose |
|---|---|
| `supabase/migrations/{ts}_meta_comments_moderation.sql` | All 5 tables + indexes + RLS. |
| `src/app/api/webhooks/meta/route.ts` | Extended for HMAC + comment routing. |
| `src/lib/meta.ts` | Existing helpers + new `likeComment`. |
| `src/lib/meta-product-match.ts` | URL → product.handle. |
| `src/lib/inngest/social-comment-moderate.ts` | Sonnet moderation handler. |
| `src/lib/social-comment-orchestrator.ts` | Sonnet v2 fork — tools + schema for comments. |
| `src/lib/social-comment-actions.ts` | Executes reply/hide/delete/like/ban from Sonnet decisions. |
| `src/app/dashboard/social-comments/page.tsx` | List view. |
| `src/app/dashboard/social-comments/[id]/page.tsx` | Detail view. |
| `src/app/dashboard/social-comments/banned/page.tsx` | Banned users. |
| `src/app/dashboard/settings/integrations/meta/page.tsx` | Multi-page management UI. |
| `src/app/api/workspaces/[id]/social-comments/route.ts` | List + bulk action API. |
| `src/app/api/workspaces/[id]/social-comments/[commentId]/route.ts` | Per-comment actions. |
| `src/app/api/workspaces/[id]/meta-pages/route.ts` | Multi-page CRUD. |
| `scripts/migrate-social-comments-tickets.ts` | One-shot migration. |

## Conventions

- **Banning is workspace-wide, not page-specific** — if you ban a user, they're banned across every page you connect.
- **Page Access Tokens are per-page**, not workspace-wide. Each `meta_pages` row carries its own token (long-lived from `me/accounts`).
- **Comments are never tickets**. Old `social_comments` channel on tickets gets retired after migration.
- **Sentiment is set by Sonnet** during moderation, stored on the row. Not a separate classifier.
- **DM behavior is unchanged** — DMs stay as tickets in the `meta_dm` channel.
- **AI moderation runs once per comment** at ingest. Subsequent edits / nested replies don't re-trigger Sonnet (avoids loops on long threads).
- **Sandbox mode applies** — when on, AI decisions appear as suggestions; no Graph API actions fire.
