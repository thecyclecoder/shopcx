# Ban a Meta user

Block a sender from commenting on our FB pages + DMing us. Optionally hide all existing comments by them.

## Helper

```ts
import { banUser } from "@/lib/social-comment-actions";
```

**File:** `src/lib/social-comment-actions.ts` (line 359)

## Signature

```ts
async function banUser(args: {
  admin: SupabaseAdminClient;
  workspaceId: string;
  senderId: string;            // meta_sender_id
  senderName?: string;
  senderUsername?: string;
  reason: string;
  bannedBy: string;            // user_id of the operator
  hideAllExisting?: boolean;
}): Promise<void>
```

## Minimal example

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { banUser } from "@/lib/social-comment-actions";

const admin = createAdminClient();

await banUser({
  admin,
  workspaceId,
  senderId: comment.meta_sender_id,
  senderName: comment.sender_name,
  senderUsername: comment.sender_username,
  reason: "Repeat troll — racist comments",
  bannedBy: currentUserId,
  hideAllExisting: true,
});
```

## What this does

1. Upserts [[../tables/banned_meta_users]] with `(workspace_id, meta_sender_id)`. Idempotent — if already banned, updates reason + clears `unbanned_at`.
2. For every active FB page in the workspace: calls Meta Graph's block-user API (real Meta-side block, stops the user from commenting on the Page, prevents them from seeing the Page's ads, blocks messaging). **IG has no equivalent API** — IG bans fall back to hiding existing comments + skipping future ones via `banned_meta_users` filter.
3. If `hideAllExisting=true`: iterates all still-public comments by this user across every page and hides them.

## Future comments

Once banned, [[../inngest/social-comment-moderate]] filters inbound comments from this sender at ingestion — they never reach the orchestrator.

## Unban

```ts
import { unbanUser } from "@/lib/social-comment-actions";

await unbanUser({
  admin,
  workspaceId,
  senderId: comment.meta_sender_id,
  unbannedBy: currentUserId,
});
```

Soft-unbans by setting `unbanned_at` — keeps the audit trail.

## Gotchas

- **IG bans are only partial.** Meta's IG Graph doesn't expose a block-user endpoint. We can only hide + filter.
- **`banned_by`** should be the user UUID, not the display_name. For system bans, pass a known system user id.
- **Idempotent.** Calling `banUser` twice with the same sender just refreshes the timestamps.
- **Reason is required.** Don't pass empty strings — admin queries filter on reason.

## Related

[[hide-comment]] · [[link-meta-sender-to-customer]] · [[../libraries/social-comment-actions]] · [[../integrations/meta-graph]] · [[../tables/banned_meta_users]] · [[../tables/social_comments]]
