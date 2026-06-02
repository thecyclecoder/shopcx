# libraries/social-comment-orchestrator

Two-pass Sonnet pipeline: pass 1 Haiku classifier, pass 2 Sonnet reply generator. See [[../lifecycles/social-comment-moderation]].

**File:** `src/lib/social-comment-orchestrator.ts`

## File header

```
Two-pass Meta-comments moderator.
─── PASS 1 — Haiku (claude-haiku-4-5) ───
Cheap, fast triage. Classifies the comment into one of:
- clean       → pass through to Pass 2
- spam        → auto: hide
- sexual      → auto: delete + ban
- abusive     → auto: delete + ban
- irrelevant  → auto: ignore
Pass 1 NEVER drafts a reply — that's Opus's job.
─── PASS 2 — Opus 4.7 (claude-opus-4-7) ───
Only runs on "clean" comments. Full context + KB + macros + sender
history. Considers the reply through three lenses:
- helpfulness for the commenter
- public impact (how does this read to other browsers?)
- sales consideration (does this build social proof / drive intent?)
Decides:
- action: reply | hidden_reply | like | escalate | ignore
- visibility: 'public' | 'hidden' (only relevant when reply-ish)
- reply_body: actual draft
- considers: structured reasoning for review
- kb_sources: which articles/macros informed it
─── ModerationDecision contract ───
Both passes converge on the same output shape so applyModerationDecision
doesn't care which pass produced it. Pass 1 short-circuits with the
non-clean classifications; Pass 2 fills in everything else.
```

## Exports

### `moderateSocialComment` — function

```ts
async function moderateSocialComment(workspaceId: string, socialCommentId: string, humanHint: string | null = null,) : Promise<ModerationDecision>
```

### `ModerationConsiders` — interface

### `ModerationDecision` — interface

### `ModerationAction` — type

### `ModerationSentiment` — type

## Callers

- `src/lib/inngest/social-comment-moderate.ts`
- `src/lib/social-comment-actions.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
