# Social comment moderation

Inbound comments on Facebook + Instagram posts (organic AND ad-served) get classified, replied to, and either hidden or kept visible — all without an agent. This is the highest-volume + lowest-friction surface we run, and it has a fundamentally different orchestration shape than email/chat because the audience is public.

## Cast

- Inbound: [[../integrations/meta-graph]] webhook → `src/lib/social-comment-ingest.ts`.
- Storage: [[../tables/social_comments]], [[../tables/social_comment_replies]], [[../tables/meta_post_cache]], [[../tables/meta_webhook_raw]].
- Customer match: [[../tables/meta_sender_customer_links]], [[../tables/customers]], [[../tables/banned_meta_users]].
- Product match: [[../tables/products]], [[../tables/product_variants]] via `src/lib/meta-product-match.ts`.
- Brain: `src/lib/social-comment-orchestrator.ts` (Sonnet two-pass).
- Actions: `src/lib/social-comment-actions.ts` (reply / hide / delete via Meta Graph).
- Pipeline: [[../inngest/social-comment-moderate]].

## Why social comments differ

Public surface. Every reply is visible to the next reader. That changes the rules:

- **Build value publicly** — when a customer raises a price objection, address it rather than hide it. See feedback_no_hidden_price_objections.
- **Canonical product URL** — if the comment references a product, the reply must link to the canonical product page, not the ad's destination url. See project_meta_comments_ad_detection.
- **No coupons** — sending a coupon in a public reply would invite abuse + degrade margins. Coupons only via DM.
- **Brand voice mandatory** — `social_brand_proof_points` on [[../tables/workspaces]] feeds the orchestrator the brand's stance points.
- **Never reveal AI** — Suzie persona, no robot disclosure. See feedback_customer_signoff_persona.

## Phase 1 — webhook capture

Meta posts to `/api/webhooks/meta/route.ts` for `feed` (comments + replies) + `messages` (DMs). Same handler.

For comments:

1. **Verify signature** — SHA-256 against app secret. Drop mismatches.
2. **Persist raw payload** to [[../tables/meta_webhook_raw]] (for replay during debugging — see project_db_lockup_diagnosis).
3. **Resolve workspace** via `entry.id` ↔ [[../tables/meta_pages]].
4. **Filter** — drop comments on our own page replies (we don't moderate ourselves), drop banned senders ([[../tables/banned_meta_users]]).
5. **Persist** to [[../tables/social_comments]] with `meta_comment_id` (idempotency key), `meta_post_id`, `meta_sender_id`, `comment_text`, `created_time`.
6. **Fire Inngest** `social-comments/new` → [[../inngest/social-comment-moderate]].

## Phase 2 — post + ad attribution

Meta delivers comment payloads with limited context. Before classifying, we cache the post:

- Look up [[../tables/meta_post_cache]] by `meta_post_id`.
- If missing, call Meta Graph `/{post_id}?fields=message,attachments,...`.
- For ad-served posts, the canonical attribution is `effective_object_story_id` on `adcreatives`. The post-id we see on the comment might be a preview-served variant; the canonical story id maps back to one underlying creative.
- Cache aggressively — post text + image + ad destination URL are immutable for our purposes.

See project_meta_comments_ad_detection for the bimodal ad/organic detection logic.

## Phase 3 — customer match

`src/lib/social-comment-customer-match.ts`:

1. Look up [[../tables/meta_sender_customer_links]] by `meta_sender_id`. If matched → done.
2. If unmatched → leave as anonymous. The orchestrator handles anonymous senders differently (no order references, can't pull subscription state).
3. Agents can manually link via the sidebar in the ticket detail UI — adds a row to [[../tables/meta_sender_customer_links]]. See [[customer-link-confirmation]] for the broader Meta-sender-to-customer flow.

## Phase 4 — pass 1: classification

`src/lib/social-comment-orchestrator.ts` runs **two passes** on every comment.

### Pass 1 — Haiku classifier

Cheap fast call. Classifies the comment as one of:

- `product_question` — asking about ingredients, usage, benefits.
- `price_objection` — pushing back on cost.
- `complaint` — bad experience, support issue.
- `compliment` — positive feedback.
- `tag_friend` — comment is just a friend's name (don't engage publicly).
- `spam_or_competitor` — drop. Hide if hostile.
- `coupon_request` — asking for a code (route to DM).
- `order_status` — asking about their order.
- `cancel_intent` — asking to cancel via comments (route to DM).
- `medical_advice_request` — never engage. Drop.

Output is a JSON `{category, sentiment, hide_recommended}`. Drives whether pass 2 runs at all (spam/medical → hide + drop, never reach pass 2).

### Pass 2 — Sonnet reply generator

Only runs if pass 1 didn't terminate. Sonnet gets:

- Cached post text + ad attribution (so it understands the comment's context).
- Brand proof points from [[../tables/workspaces]].`social_brand_proof_points`.
- Customer state if matched (orders, subs).
- Canonical product URL via `meta-product-match.ts`.
- The `sonnet_prompts` rule pack including social-specific rules ([[../tables/sonnet_prompts]]).

Sonnet returns:

```json
{
  "reply_text": "...",
  "action_type": "reply | reply_then_dm | hide | hide_then_dm | drop",
  "dm_text": "...",  // only when *_dm
  "product_url": "...",  // canonical product URL if referenced
  "reasoning": "..."
}
```

## Phase 5 — execute

`src/lib/social-comment-actions.ts` dispatches:

- `reply` → POST `/{comment_id}/comments` on [[../integrations/meta-graph]] with `message=reply_text`.
- `reply_then_dm` → reply publicly + send a DM via `/{conversation_id}/messages`. Coupon offers + cancel intents take this path so the public surface stays clean.
- `hide` → POST `/{comment_id}` with `is_hidden=true`. The author still sees their own comment; the public + we don't.
- `hide_then_dm` → hide + DM. Used for complaints that should be addressed privately.
- `drop` → nothing. Logged for retrospective only.

Every action writes to [[../tables/social_comment_replies]]:

- `meta_comment_id`, `action`, `reply_text`, `dm_text`, `success`, `error`.
- Used for retrospective + dashboard moderation queue.

## Phase 6 — orchestrator regenerate on human context

If an agent reviews a comment and adds context (e.g. "this customer had a chargeback last week"), the orchestrator can regenerate the reply with that context baked in. The regenerate button is on the comment detail UI. New reply replaces the queued one if not yet sent.

If the reply was already posted, the agent has to manually delete + replace via Meta — we don't auto-overwrite public replies.

## Phase 7 — historical backfill

[[../inngest/meta-historical-comments-sync]] backfills comments from historical posts and ads. Runs on-demand from `/dashboard/social-comments/historical`. Per-page sync — pulls posts via Meta Graph, then comments per post, then runs the same orchestrator pass on each. Useful for cleaning up months of unmoderated ad comments.

## Channel rules

- **journeys: never** delivered on social_comments. Hard rule in [[../tables/journey_definitions]].`channels`.
- **playbooks: never** triggered on social_comments. Playbooks require a private channel for the multi-step conversation.
- **macros: rarely** — only when the agent manually selects one. The AI prefers Sonnet-generated replies that incorporate the post context.

## Anti-patterns we explicitly avoid

- **Hiding price objections.** Build value publicly. See feedback_no_hidden_price_objections.
- **Sending coupons in public replies.** Always DM. See feedback_no_coupons_in_public.
- **Linking to ad destinations.** Always canonical product URLs. See feedback_canonical_product_url.
- **Engaging on tag-friend comments.** Their friend wasn't asking us anything.
- **AI disclosure.** Suzie. Never "as an AI."
- **Apologizing reflexively.** See feedback_no_reflexive_apology_or_apology_coupon.

## Mute / ban

Repeat trolls go on [[../tables/banned_meta_users]] (workspace-scoped). Future comments from a banned sender drop at ingestion — never reach orchestrator, no DB cost beyond the raw log.

Admins ban via the comment detail UI. Unbans also via the UI; the row gets soft-deleted (`unbanned_at` set), not hard-deleted, so we have history.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/social-comment-ingest.ts` | Webhook parser + persist |
| `src/lib/social-comment-orchestrator.ts` | Two-pass Sonnet classifier + generator |
| `src/lib/social-comment-actions.ts` | Reply / hide / DM via Meta Graph |
| `src/lib/social-comment-customer-match.ts` | Sender ↔ customer matching |
| `src/lib/meta.ts` | Meta Graph client + token helpers |
| `src/lib/meta-product-match.ts` | Comment text → product UUID via embeddings + Haiku |
| `src/lib/meta-test-helpers.ts` | Mock helpers for tests |
| `src/lib/inngest/social-comment-moderate.ts` | Per-comment Inngest pipeline |
| `src/lib/inngest/meta-sync.ts` | Page/IG sync |
| `src/lib/inngest/meta-historical-comments-sync.ts` | Backfill from historical posts |
| `src/app/api/webhooks/meta/route.ts` | Meta webhook handler |
| `src/app/dashboard/social-comments/page.tsx` | Moderation queue UI |

## Status / open work

**Shipped:** Two-pass orchestration (Haiku classifier + Opus generator). is_published / promotion_status / ad_id cascade for ad classification. Haiku fallback for organic-post product matching. IG `/replies` vs FB `/comments` endpoint dispatch. Resolution-gate-then-rate analogous flow not applicable here, but "Flag as competitor promotion" agent button + workspace competitor deny-list ARE shipped. Customer-name match + agent "Confirm match" persistent link. Brand proof points + objection handling. Regenerate-with-context button.

**Known gaps / not yet shipped:**
- **JIT ad-creative lookup** — Marketing API doesn't support `EQUAL` filtering on `effective_object_story_id`. Long-term fix is a one-time + daily creative sync to a local table. Today, ad classification falls through is_published / promotion_status. Documented at the end of `commit 22206b13`.

**Recent activity:**
- `4b7d6eca` Social comments: use IG /replies endpoint when commenting on Instagram
- `ce9c6498` Social comments: competitor-promotion detection + agent flag button
- `62ca4972` Social-comment orchestrator: never hide price objections, build value publicly

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[ai-multi-turn]] · [[customer-link-confirmation]] · [[../integrations/meta-graph]] · [[../integrations/anthropic]] · [[../tables/social_comments]] · [[../tables/social_comment_replies]] · [[../tables/meta_post_cache]] · [[../tables/meta_sender_customer_links]] · [[../tables/banned_meta_users]] · [[../inngest/social-comment-moderate]] · [[../inngest/meta-historical-comments-sync]]
