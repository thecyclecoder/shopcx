# review_message_drafts

One row per drafted review-request message. Every draft persists with its **rubric self-score**, **independent-QC verdict**, **deterministic-validator verdict**, and **eventual outcome** so a later grader sweep can correlate rubric scores against real response rates and tune the rubric on evidence instead of taste.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `customer_id` | `uuid` | — | → [[customers]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | ✓ | → [[products]].id · ON DELETE SET NULL. The product this draft asks about — always a reviewable one (Sol's session enforces `products.reviewable=true`). |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id · ON DELETE SET NULL. The ticket the goodwill came from; anchors the draft to Sol's review-candidacy session. Null iff the draft was authored out-of-band (a hand-picked one-off, not the ladder). |
| `review_request_id` | `uuid` | ✓ | → [[review_requests]].id · ON DELETE SET NULL. The ladder-minted ask row this draft became when the send actually happened. Null pre-send. |
| `channel` | `text` | — | `email` \| `sms` — matches [[review_requests]].channel. |
| `angle` | `text` | — | `defend` \| `fence-sitter` — the two pretexts the spec pins. Free-text so a future angle doesn't need a migration; validated at author time by [[../libraries/review-request-validator]] `validateReviewRequest` (rail: `unapproved_pretext`). |
| `subject` | `text` | ✓ | Email subject line; null for SMS. |
| `body` | `text` | — | The customer-facing text. |
| `rubric_version` | `integer` | ✓ | The version of [[review_message_rubrics]] this draft was scored against — snapshot, not a live join, so a later version bump can't mis-attribute an older draft's score. |
| `self_score` | `jsonb` | ✓ | Sol's own scoring output. Shape: `{ total: int, per_criterion: { <key>: int }, revision_count: int }`. Null iff the draft was never scored (a validator hard-block short-circuits before scoring). |
| `qc_verdict` | `jsonb` | ✓ | The INDEPENDENT-QC session's verdict — a second Sol session that did NOT write the draft. Shape: `{ verdict: 'pass'\|'fail', reasons: string[], reasoning: string }`. Null pre-QC. |
| `validator_verdict` | `jsonb` | ✓ | The deterministic pre-send validator's verdict (source: [[../libraries/review-request-validator]] `validateReviewRequest`). Shape: `{ allow: bool, reasons: string[] }`. A row with `validator_verdict.allow=false` is persisted for provenance but NEVER sent. |
| `outcome` | `text` | — | default: `'drafted'` · lifecycle marker — `drafted` → `validated` → `sent` → `clicked` → `submitted` \| `skipped` \| `expired`. Text so the ladder can add outcomes without a migration; readers probe actual values (CLAUDE.md § "Database is the spec"). |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` · maintained by the `review_message_drafts_touch_updated_at` trigger |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (ON DELETE CASCADE)
- `customer_id` → [[customers]].`id` (ON DELETE CASCADE)
- `product_id` → [[products]].`id` (ON DELETE SET NULL)
- `ticket_id` → [[tickets]].`id` (ON DELETE SET NULL)
- `review_request_id` → [[review_requests]].`id` (ON DELETE SET NULL)

**In (others → this):**

_None._

## Indexes

- `review_message_drafts_workspace_customer_idx (workspace_id, customer_id, created_at desc)` — "every draft for this customer, most recent first" — the grader sweep's read.
- `review_message_drafts_ticket_idx (ticket_id) where ticket_id is not null` — ticket → draft lookup on ticket page.
- `review_message_drafts_review_request_idx (review_request_id) where review_request_id is not null` — draft → sent-ask lookup after the send lands.
- `review_message_drafts_outcome_idx (workspace_id, outcome, created_at desc)` — bucket-by-outcome for the roadmap card.

## RLS

- `review_message_drafts_member_read` — any authenticated workspace member can select rows for their workspaces.
- `review_message_drafts_service_role` — service role does all writes.

## Common queries

### Persist a draft (SDK — never raw)
```ts
import { saveReviewMessageDraft } from "@/lib/review-message-drafts";
const draftId = await saveReviewMessageDraft(admin, {
  workspaceId, customerId, productId, ticketId, reviewRequestId: null,
  channel: "email", angle: "fence-sitter",
  subject: "quick question", body: "…",
  rubricVersion: 1,
  selfScore: { total: 88, per_criterion: {…}, revision_count: 0 },
  qcVerdict: { verdict: "pass", reasons: [], reasoning: "…" },
  validatorVerdict: { allow: true, reasons: [] },
});
```

### Grader-sweep read — rubric vs response rate
```ts
const { data } = await admin
  .from("review_message_drafts")
  .select("id, rubric_version, self_score, outcome, created_at")
  .eq("workspace_id", workspaceId)
  .in("outcome", ["submitted", "clicked", "sent", "skipped"])
  .gte("created_at", ninetyDaysAgo);
// group by rubric_version and self_score bucket, correlate with outcome.
```

## Gotchas

- **A row is written when the draft is authored, not when it sends.** `outcome='drafted'` covers the pre-send state; the send path transitions it to `'sent'`. A row that stops at `'drafted'` never went out — the validator or QC session blocked it.
- **A validator-blocked row is still persisted.** `validator_verdict.allow=false` rows exist so a later grader sweep can see which drafts died where. The row's outcome stays `'drafted'` (never advanced).
- **`rubric_version` is a snapshot.** A workspace's rubric version bump does not rewrite older drafts' scores against the new criteria; the join `(workspace_id, rubric_version)` locates the exact rubric the row was scored under.
- **Never insert with `outcome='sent'` before delivery confirmation.** The send path stamps `outcome` only AFTER `deliverPendingSends` reports success. A row can never lie about having sent.

---

[[../README]] · [[../../CLAUDE]] · [[review_message_rubrics]] · [[review_requests]] · [[../libraries/review-message-rubric]] · [[../specs/review-request-sol-session]]
