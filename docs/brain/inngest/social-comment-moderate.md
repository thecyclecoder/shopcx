# inngest/social-comment-moderate

Per-comment moderation pipeline — runs the orchestrator, posts replies, hides/deletes if needed. Writes `social_comments`, `social_comment_replies`.

**File:** `src/lib/inngest/social-comment-moderate.ts`

## Functions

### `social-comment-moderate`
- **Trigger:** event `social/comment.created`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspace_id" }]`


## Downstream events sent

_None._

## Tables written

_None._

## Tables read (not written)

_None._

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
