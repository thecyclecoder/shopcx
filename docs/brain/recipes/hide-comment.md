# Hide a comment

Hide a Meta / Instagram comment from public view. The author still sees their own comment; the public + we don't.

## Helper

```ts
import { applyModerationDecision } from "@/lib/social-comment-actions";
```

**File:** `src/lib/social-comment-actions.ts` (line 49)

## Minimal example

```ts
import { applyModerationDecision } from "@/lib/social-comment-actions";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

await applyModerationDecision({
  admin,
  workspaceId,
  comment,                       // the social_comments row
  decision: {
    action: "hide",
    reply_text: null,
    dm_text: null,
    reasoning: "Spam / off-topic",
  },
});
```

`decision.action` can also be `"reply"`, `"reply_then_dm"`, `"hide_then_dm"`, or `"drop"`.

## Direct hide (no orchestrator decision)

If an agent clicks "Hide" in the moderation queue UI, the lower-level helper is:

```ts
import { executeAction } from "@/lib/social-comment-actions";

await executeAction({
  admin,
  workspaceId,
  metaCommentId: comment.meta_comment_id,
  pageId: comment.meta_page_id,
  action: "hide",
});
```

This skips the decision-recording flow and just calls Meta Graph `POST /{comment-id}` with `is_hidden=true`.

## Gotchas

- **`is_hidden`, not `hidden`.** Meta's API uses `is_hidden=true`.
- **Hiding doesn't delete** — the author still sees their comment, just not the public. Use `delete` for permanent removal.
- **Hide then DM**: when an issue should be addressed privately, hide the public comment and DM the user. The orchestrator picks this for complaints.
- **Repeat trolls** should go on [[../tables/banned_meta_users]] — see [[ban-meta-user]].
- **IG comments** support the same API but some hide variants don't work for replies-to-comments. Test before assuming.

## Related

[[ban-meta-user]] · [[link-meta-sender-to-customer]] · [[../libraries/social-comment-actions]] · [[../integrations/meta-graph]] · [[../lifecycles/social-comment-moderation]] · [[../tables/social_comments]]
