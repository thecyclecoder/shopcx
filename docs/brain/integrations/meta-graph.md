# meta-graph

Meta Graph API — Facebook Pages, Instagram, Messenger DMs, post comments. Used for **organic** social management: ingesting comments + DMs as tickets, replying, hiding/deleting. (For paid ads / Marketing API see [[meta-marketing]].)

## Auth

**Per-workspace Facebook OAuth.** Admin logs in with Facebook, selects the page(s) we manage; we store the long-lived Page Access Token.

- **Encrypted on `workspaces`:**
  - `meta_page_access_token_encrypted` — per-page long-lived token (the one we actually use)
  - `meta_user_access_token_encrypted` — admin user token, used only to mint page tokens
- **Plain on `workspaces`:**
  - `meta_page_id` — connected Facebook Page id
  - `meta_page_name` — display name (for UI)
  - `meta_instagram_id` — connected IG Business Account id
  - `meta_webhook_verify_token` — token Meta uses to verify webhook setup
  - `meta_oauth_state` — in-flight OAuth state nonce
  - `meta_connected_admin_email` / `meta_connected_admin_name` — who connected

OAuth scopes: pages_show_list, pages_manage_metadata, pages_messaging, pages_read_engagement, pages_manage_engagement, instagram_basic, instagram_manage_comments, instagram_manage_messages, ads_read, ads_management.

## API version

`META_GRAPH_VERSION` (`src/lib/meta.ts`). Typically `v20.0` or `v21.0` — bump quarterly.

Base: `https://graph.facebook.com/{version}`

## Key endpoints we call

| Endpoint | Method | Purpose |
|---|---|---|
| `/{page-id}` | GET | Page metadata + token validation |
| `/{page-id}/feed` | GET | List posts |
| `/{post-id}/comments` | GET | List comments on a post |
| `/{comment-id}` | DELETE / GET / POST | Hide (POST is_hidden=true), delete, reply (POST message=...) |
| `/{page-id}/conversations` | GET | List DM threads (Messenger) |
| `/{conversation-id}/messages` | GET / POST | List + send DM messages |
| `/{ig-user-id}/media` | GET | List Instagram posts |
| `/{ig-comment-id}` / `/replies` | GET / POST / DELETE | IG comments mirror FB but with IG IDs |
| `/me/permissions` | GET | Check granted scopes |

## Webhooks

Per-page webhook subscriptions for `feed` (comments on posts/ads) + `messages` (DMs). Verified via `meta_webhook_verify_token` (Meta GET ?hub.verify_token=... at setup) + SHA-256 signature on each POST (using app secret).

Inbound flow: webhook → raw stored in [[../tables/meta_webhook_raw]] → match to existing thread or create new [[../tables/social_comments]] / [[../tables/tickets]] row → fires `ticket/inbound-message`.

## Rate limits + retry

- Meta uses "app-level" + "page-level" budgets, exposed via response headers `X-App-Usage` + `X-Page-Usage` as percent-utilization.
- Hard rate limit kicks in around 80% — we back off when usage > 60%.
- 429 + `error.code=4` → temporary block. Wait + retry.
- 190 + `error.subcode=460` → token expired; re-auth needed (notify admin).

## Comment attribution (ad vs organic)

Comments on ad-served posts have `ad_id`; organic + preview-served don't. Canonical attribution uses `effective_object_story_id` on `adcreatives` to map ads back to the underlying post. Cached in [[../tables/meta_post_cache]]. See project_meta_comments_ad_detection.

## Gotchas

- **Page Access Token != User Access Token.** User tokens expire in ~60 days; Page tokens mint with the `manage_pages` permission and are long-lived. We always use the page token for API calls; the user token only mints the page token.
- **`meta_user_access_token_encrypted` was added retroactively** to support refresh-on-demand. Older workspaces may not have it set.
- **Comment visibility flag** is `is_hidden`, not `hidden`. Reply visibility is determined by `can_reply` on the parent.
- **Banned senders** — [[../tables/banned_meta_users]] (workspace-scoped). Check before posting any reply or accepting any inbound DM.
- **Webhook payloads are batched** — one POST can carry multiple `entry[].changes[]`. Iterate.
- **At-least-once delivery** — idempotency key is the comment/message id.
- **Removing your app from a Page wipes the token immediately.** Surface a banner to admin if `/me/permissions` shows missing scopes.

## Files

- `src/lib/meta.ts` — Auth URLs + Graph API client + permission check
- `src/lib/inngest/meta-sync.ts` — Per-page sync
- `src/lib/inngest/meta-historical-comments-sync.ts` — Backfill comments from historical posts/ads
- `src/lib/inngest/social-comment-moderate.ts` — Per-comment moderation pipeline
- `src/lib/social-comment-orchestrator.ts` — AI decision per comment
- `src/lib/social-comment-actions.ts` — Reply / hide / delete actions
- `src/lib/social-comment-ingest.ts` — Webhook ingestion
- `src/lib/social-comment-customer-match.ts` — Match comment author → customer
- `src/lib/meta-product-match.ts` — Match comment text → product
- `src/lib/meta-test-helpers.ts` — Mock helpers for tests

## Related

[[../tables/social_comments]] · [[../tables/social_comment_replies]] · [[../tables/meta_pages]] · [[../tables/meta_connections]] · [[../tables/meta_webhook_raw]] · [[../tables/meta_post_cache]] · [[../tables/meta_sender_customer_links]] · [[../tables/banned_meta_users]] · [[../inngest/meta-sync]] · [[../inngest/meta-historical-comments-sync]] · [[../inngest/social-comment-moderate]]
