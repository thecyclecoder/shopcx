# libraries/review-message-rubric

Rubric SDK — the source-of-truth reader + renderer for the versioned review-request message rubric (Phase 2 of [[../specs/review-request-sol-session]]).

**File:** `src/lib/review-message-rubric.ts`

The rubric is DATA, not a hardcoded prompt string — 8 criteria, 100 points, floor 75, versioned per workspace in [[../tables/review_message_rubrics]]. Sol self-scores her draft against the ACTIVE rubric and MUST revise once below the floor; the independent QC session reads the same rubric so both sides of the check are grounded in the same criteria set. A later grader sweep can tune weights on evidence by inserting a new version + flipping `is_active` — no code change, no prompt-string edit.

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `ReviewMessageRubricCriterion` | interface | `{ key, weight, instruction }` — one weighted criterion. |
| `ReviewMessageRubric` | interface | The parsed rubric a caller reads. |
| `INITIAL_REVIEW_RUBRIC_VERSION` | const | `1` — the seed version the migration writes. |
| `INITIAL_REVIEW_RUBRIC_FLOOR` | const | `75` — the seed floor (dahlia-copy-author parity). |
| `INITIAL_REVIEW_RUBRIC_CRITERION_COUNT` | const | `8` — the criteria count the spec pins. |
| `parseRubricRow(raw)` | function | PURE — turn a raw `review_message_rubrics` row into a validated `ReviewMessageRubric`; throws on any structural miss. |
| `formatRubricForPrompt(rubric)` | function | PURE — render the rubric as a plain-text block for Sol's self-score / QC prompt. |
| `getActiveReviewRubric(admin, workspaceId)` | async function | Live reader — resolves the ACTIVE rubric row via `.from("review_message_rubrics")`. Returns `null` when no active row exists (caller treats a null as hard SKIP). |

## Design

Two halves — the pure parser/renderer is unit-tested in isolation (`src/lib/review-message-rubric.test.ts`); the live reader wraps `parseRubricRow` around a Supabase call. `parseRubricRow` throws on any of:

- row is null / not an object
- missing `id` / `workspace_id`
- `version` not a positive integer
- `floor` outside `[0, 100]`
- `criteria` not a non-empty array
- criterion missing `key` / `instruction`
- criterion `weight` ≤ 0
- criterion `weight` values do not sum to 100

The throw messages name the exact miss so a caller can diagnose without re-reading the row.

## Callers

- `getActiveReviewRubric` will be called by:
  - The compose stage of Sol's review-request drafting session (Phase 2 wires this in) — Sol reads the rendered rubric block and self-scores her draft.
  - The independent-QC session (Phase 2) — the second session re-reads the SAME rubric so both sides of the check are grounded identically.
  - A later grader sweep — reads all rubric versions for a workspace to correlate scores against real response rates.

- `formatRubricForPrompt` is called at Sol's compose time to bake the rubric into the LLM prompt verbatim — the same list Sol scores against.

## Related

- [[../tables/review_message_rubrics]] — the table.
- [[../tables/review_message_drafts]] — where each draft's self-score + rubric_version snapshot lands.
- [[review-message-drafts]] — the sibling drafts persister SDK.
- [[review-request-validator]] — the deterministic sibling of the rubric (hard-blocks; no LLM taste).
- [[../specs/review-request-sol-session]] — the spec this SDK implements.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/review_message_rubrics]]
