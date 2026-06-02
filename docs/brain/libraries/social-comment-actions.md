# libraries/social-comment-actions

`replyComment()`, `hideComment()`, `deleteComment()`, `sendDMReply()` via [[../integrations/meta-graph]].

**File:** `src/lib/social-comment-actions.ts`

## File header

```
Action executor for the Meta comments moderation orchestrator.
Takes a ModerationDecision + the social_comments row, fires the
matching Graph API call, and reconciles the database:
- reply    → POST /{comment-id}/comments, insert reply row, status='replied'
- like     → POST /{comment-id}/likes, set liked_at
- hide     → POST /{comment-id} {is_hidden:true}, status='hidden'
- delete   → DELETE /{comment-id}, status='deleted'
- ignore   → no API call, status stays 'open', moderation_source recorded
- escalate → status='escalated', assigned_to set via round-robin agent
- ban_user → adds to banned_meta_users + auto-hides all existing comments
Sandbox mode: when workspaces.sandbox_mode is on, we record the AI
suggestion fields on the social_comments row (ai_action / ai_reply_body /
ai_reasoning / ai_ran_at, moderation_source='ai_suggested') and do
NOT fire any Graph API call. An agent reviews and approves from the
detail view, which calls executeAgentAction() to actually fire.
```

## Exports

### `applyModerationDecision` — function

```ts
async function applyModerationDecision(workspaceId: string, socialCommentId: string, decision: ModerationDecision,) : Promise<
```

### `executeAction` — function

```ts
async function executeAction(args: ExecuteArgs) : Promise<
```

### `banUser` — function

```ts
async function banUser(args: BanArgs) : Promise<void>
```

### `unbanUser` — function

```ts
async function unbanUser(workspaceId: string, senderId: string, actorUserId: string | null,) : Promise<void>
```

## Callers

- `src/app/api/workspaces/[id]/banned-meta-users/[senderId]/route.ts`
- `src/app/api/workspaces/[id]/social-comments/[commentId]/route.ts`
- `src/lib/inngest/social-comment-moderate.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
