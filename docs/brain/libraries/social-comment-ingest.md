# libraries/social-comment-ingest

Webhook parser + persist for inbound comments + DMs.

**File:** `src/lib/social-comment-ingest.ts`

## File header

```
Comment ingestion path off the Meta webhook.
Responsibilities (in order):
1. Normalize FB-feed vs IG-comments payloads into a single shape.
2. Hydrate post context — fetch + cache the parent post once so
every subsequent comment on that post is fast.
3. Insert the social_comments row.
4. Apply rule-based moderation BEFORE Sonnet:
a. ban list   → auto-hide via Graph API
b. policy off → leave open for manual moderation
5. Fire `social/comment.created` Inngest event so the Sonnet
moderation handler runs async (the webhook needs to 200 fast).
Verbs handled:
- 'add'    → insert new row
- 'edited' → bump body + edited_at
- 'remove' → mark deleted_by_user_at (Meta-side deletion by user)
- 'hide' / others → ignored (Meta confirms our own hide actions)
```

## Exports

### `ingestSocialComment` — function

```ts
async function ingestSocialComment(args: IngestArgs) : Promise<void>
```

## Callers

- `src/app/api/webhooks/meta/route.ts`
- `src/lib/inngest/meta-historical-comments-sync.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
