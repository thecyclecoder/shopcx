# Worktree: Meta Social Integration

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-meta-social feature/meta-social
cd ../shopcx-meta-social
npm install
```

Work in `/Users/admin/Projects/shopcx-meta-social` — NOT main.

## What to Build

Connect Facebook and Instagram for DM management and comment moderation. Messages from Meta create tickets with `channel: "meta_dm"` or `channel: "social_comments"`.

## Meta Graph API Setup

### Required Permissions
- `pages_messaging` — send/receive DMs
- `pages_read_engagement` — read comments
- `pages_manage_metadata` — manage page
- `instagram_basic` — Instagram profile
- `instagram_manage_messages` — Instagram DMs
- `instagram_manage_comments` — Instagram comments

### OAuth Flow
Similar to Shopify OAuth. Store:
- `meta_page_id` on workspace
- `meta_page_access_token_encrypted` on workspace
- `meta_instagram_id` on workspace

### Webhooks
Meta sends webhooks for:
- `messages` — new DM received
- `feed` — new comment on posts
- `mention` — @mention on Instagram

Webhook URL: `https://shopcx.ai/api/webhooks/meta`

## Database Changes

```sql
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_page_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_page_access_token_encrypted TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_instagram_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_webhook_verify_token TEXT;
```

## Files to Create

### `src/app/api/webhooks/meta/route.ts`
- GET: webhook verification (hub.verify_token challenge)
- POST: process incoming messages/comments
  - DMs → create ticket with `channel: "meta_dm"`
  - Comments → create ticket with `channel: "social_comments"`
  - Thread by sender ID

### `src/lib/meta.ts`
- `sendMetaDM(pageAccessToken, recipientId, message)` — reply to DM
- `replyToComment(pageAccessToken, commentId, message)` — reply to comment
- `getPageProfile(pageAccessToken)` — get page info

### `src/app/api/auth/meta/route.ts` + callback
- OAuth flow for Meta Pages
- Exchange code for page access token
- Store encrypted

### Settings UI
- Connect Facebook Page button
- Shows connected page name
- Connect Instagram account
- Webhook status indicator

## Integration with Existing Systems
- DM tickets work in the existing queue (channel: "meta_dm")
- Comment tickets work in the queue (channel: "social_comments")
- AI multi-turn handles both channels (turn limit: 2 for social_dm, 1 for social_comments)
- Reply from ticket detail sends via Meta Graph API instead of email

## Social Comments: Special Handling
- `social_comments` channel has `ai_turn_limit: 1` (always)
- Comments are public — responses should be brand-appropriate
- Option to reply publicly (comment) or privately (DM)
- Hide/delete offensive comments

## Testing
1. Connect a test Facebook page
2. Send a DM → verify ticket created
3. Reply from ShopCX → verify DM sent
4. Comment on a post → verify ticket created
5. Reply to comment → verify comment posted

## When Done
Push to `feature/meta-social` branch. Tell the merge manager (main terminal) to merge.
