# libraries/review-message-drafts

Review-message-drafts SDK — the persister for every drafted review-request message (Phase 2 of [[../specs/review-request-sol-session]]).

**File:** `src/lib/review-message-drafts.ts`

Every drafted message lands in [[../tables/review_message_drafts]] with its rubric self-score, independent-QC verdict, deterministic-validator verdict, and eventual outcome so a later grader sweep can correlate rubric scores against real response rates and tune the rubric on evidence instead of taste. The WORKER (deterministic Node) is the only mutator; Sol NEVER writes to this table directly — her verdict flows THROUGH the worker, which composes the row and calls this SDK.

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `ReviewMessageChannel` | type | `'email' \| 'sms'` |
| `ReviewMessageAngle` | type | `'defend' \| 'fence-sitter'` — mirrors the two pinned pretexts. |
| `ReviewMessageSelfScore` | interface | `{ total, per_criterion, revision_count }` |
| `ReviewMessageQcVerdict` | interface | `{ verdict, reasons, reasoning }` — the independent-QC output. |
| `ReviewMessageValidatorVerdict` | interface | `{ allow, reasons }` — the deterministic-validator output. |
| `ReviewMessageDraftInput` | interface | The typed bag callers hand to the persister. |
| `ReviewMessageDraftInsertRow` | interface | The 1:1 shape `insert()` accepts — matches the migration's columns. |
| `buildDraftInsert(input)` | function | PURE — validates + maps `ReviewMessageDraftInput` → `ReviewMessageDraftInsertRow`. Throws on any structural miss. |
| `saveReviewMessageDraft(admin, input)` | async function | Live persister — wraps `buildDraftInsert` around `.from("review_message_drafts").insert().select("id").single()`; returns the new row's id or throws. |

## Design

Two halves — the pure builder is unit-tested in isolation (`src/lib/review-message-drafts.test.ts`); the live persister wraps `buildDraftInsert` around a Supabase call. `buildDraftInsert` throws on any of:

- input null / not an object
- missing `workspaceId` / `customerId`
- `channel` not `'email'` / `'sms'`
- `angle` not `'defend'` / `'fence-sitter'`
- `body` not a non-empty string

Nullable columns (`productId`, `ticketId`, `reviewRequestId`, `subject`, `rubricVersion`, `selfScore`, `qcVerdict`, `validatorVerdict`) pass through as null — a pre-QC or validator-blocked draft is still persisted for provenance.

`outcome` defaults to `'drafted'`. A whitespace-only override falls back to the default so a caller can't accidentally strand a row on an empty lifecycle marker.

## Callers

The Phase-2 compose stage (Sol's draft session's downstream worker step) calls `saveReviewMessageDraft` once per drafted message — pre-send, with the full verdict bag if it exists. Phase 3's send path is what advances `outcome` from `'drafted'` through `'sent' → 'clicked' → 'submitted'`.

## Related

- [[../tables/review_message_drafts]] — the table.
- [[../tables/review_message_rubrics]] — the versioned rubric each draft snapshots.
- [[review-message-rubric]] — the rubric SDK.
- [[review-request-validator]] — the deterministic pre-send validator whose verdict lands in `validator_verdict`.
- [[../specs/review-request-sol-session]] — the spec this SDK implements.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/review_message_drafts]]
