# review_message_rubrics

Versioned per-workspace rubric for Sol's review-request message self-score + the independent-QC pass. **Data, not a prompt string** — the whole program's message quality is scored against the rubric stored here, so a later grader sweep can tune weights on evidence (correlating rubric scores against real response rates) via a version bump, without a code change.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `version` | `integer` | — | Monotonic per workspace. Starts at 1 (seeded by the migration for every existing workspace). A grader-tuned rewrite INSERTS a new row with `version = N+1`; older rows stay for provenance so [[review_message_drafts]].rubric_version keeps its snapshot honest. |
| `criteria` | `jsonb` | — | Array of `{ key: string, weight: integer, instruction: string }`. `key` is a stable slug the grader sweep joins across versions; `weight` sums to 100 across all criteria (asserted by [[../libraries/review-message-rubric]] `parseRubricRow`); `instruction` is rendered verbatim into Sol's self-score + QC prompt. |
| `floor` | `integer` | — | default: `75` · The score a draft must clear to send. Below floor ⇒ revise once; below floor twice ⇒ skip. Mirrors the dahlia-copy-author floor pattern. |
| `is_active` | `boolean` | — | default: `true` · Exactly one active row per workspace (partial unique index). A version bump flips the prior row to false in the same transaction. |
| `notes` | `text` | ✓ | Free-text provenance — usually the reason the version was bumped (which grader-sweep finding, which experiment). |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` · maintained by the `review_message_rubrics_touch_updated_at` trigger |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (ON DELETE CASCADE)

**In (others → this):**

- Referenced by [[review_message_drafts]].`rubric_version` (integer, workspace-scoped — not a formal FK because the join key is composite (`workspace_id`, `version`); readers do the two-column lookup themselves).

## Indexes

- `review_message_rubrics_workspace_version_uniq (workspace_id, version)` — the composite the grader sweep joins by.
- `review_message_rubrics_active_uniq (workspace_id) where is_active = true` — partial unique so a version bump is atomic (flip old to false + insert new both required inside one transaction).

## RLS

- `review_message_rubrics_member_read` — any authenticated workspace member can select rows for their workspaces.
- `review_message_rubrics_service_role` — service role does all writes.

## The seeded v1 rubric

The migration seeds one row per existing workspace: `version=1`, `floor=75`, and the 8 criteria the spec pins (Phase 2 § "The rubric"):

1. `ask_is_question` (15) — the ask reads as a question, not a chore.
2. `named_person_position` (15) — a named person with a concrete position writes.
3. `status_reversal` (15) — we need help, they are the authority.
4. `founder_plain_voice` (15) — no marketing lift, no exclamation stacking.
5. `earned_identity_priming` (10) — "as a two-year customer" only when tenure warrants it.
6. `fact_in_first_two_lines` (10) — the hand-picked fact lands in the first two lines.
7. `time_cost_no_friction` (10) — time cost is stated, no sign-in / long form up front.
8. `continuity_with_thread` (10) — the message reads as coming from the same person the customer just spoke to.

Weights sum to 100. Total possible score: 100. Floor: 75.

## Common queries

### Load the ACTIVE rubric for a workspace
```ts
import { getActiveReviewRubric } from "@/lib/review-message-rubric";
const rubric = await getActiveReviewRubric(admin, workspaceId);
if (!rubric) return; // no active rubric ⇒ hard SKIP
```

### Bump the version (grader-driven tune)
```ts
await admin
  .from("review_message_rubrics")
  .update({ is_active: false })
  .eq("workspace_id", workspaceId)
  .eq("is_active", true);
await admin.from("review_message_rubrics").insert({
  workspace_id: workspaceId,
  version: nextVersion,
  criteria: tunedCriteria,
  floor: 75,
  is_active: true,
  notes: `grader sweep 2026-Q4: raised earned_identity_priming 10→15 …`,
});
```

## Gotchas

- **Exactly one active row per workspace.** A version bump must flip the old row to `is_active=false` BEFORE inserting the new one (or wrap both in a transaction) — the partial unique index will refuse two active rows.
- **Weights must sum to 100.** `parseRubricRow` throws on any other sum so a malformed row can't silently mis-score a draft.
- **A draft's `rubric_version` is a snapshot.** A version bump does NOT rewrite older drafts' scores against the new rubric — the [[review_message_drafts]] row already carries the version it was scored under.

---

[[../README]] · [[../../CLAUDE]] · [[../libraries/review-message-rubric]] · [[review_message_drafts]] · [[../specs/review-request-sol-session]]
