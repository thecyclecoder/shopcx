# libraries/cs-director-verdict-note

The **pure builder** for the internal system note that Phase 1 of [[../specs/cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict]] writes on an escalated ticket after the CS Director (June) rules.

**File:** `src/lib/cs-director-verdict-note.ts`

## What it does

Composes the internal ticket message body (visibility='internal', author_type='system') that surfaces in the ticket thread as a non-customer-visible receipt of the CS Director's review. Before this shipped, an `author_spec` or `approve_remedy` verdict left the ticket open + escalated + note-less — a CS agent scanning the queue could not tell the ticket had already been reviewed by the director.

The note payload encodes the per-verdict handoff:
- **`author_spec`** → the authored spec slug + title (when present) — **sourced from the executor's OUTCOME, not the LLM's claim** (see Phase 1 of [[../specs/cs-director-spec-claim-must-match-the-actual-write]])
- **`approve_remedy`** → a one-line summary of the RemedyPlan (kind + human summary)
- **`escalate_founder`** → the reasoning that will be escalated to the CEO

## Exports

- **`buildCsDirectorVerdictNote(verdict: CsDirectorNoteInput): string`** — pure function that composes the internal-note body. Takes a decision (`author_spec` | `approve_remedy` | `escalate_founder` | `close_no_action`), the reasoning, the per-verdict output (remedy plan or spec seed), and (for `author_spec`) the OUTCOME `handleAuthorSpec` returned. Returns the formatted note body.
- **`CsDirectorDecision`** — type alias for the four verdict shapes.
- **`CsDirectorNoteInput`** — interface for the input shape (decision, reasoning, optional remedy/spec_seed/author_outcome/recommended_remedy).
- **`CsDirectorAuthorSpecOutcome`** — interface for the `author_outcome` field: `{ specWritten, spec_slug?, reason? }`. `specWritten` (not the coarser `ok`) is the ONLY signal that authorizes the confirmed-write line; the name is the contract, kept in sync with the same-named field on [[cs-director-ticket-transition]].

## How it's used

**Caller:** `scripts/builder-worker.ts` `runCsDirectorCallJob` — writes the note body to `ticket_messages` as a compare-and-set write after the director's verdict is audited to `director_activity`. The write path is `{visibility:'internal', author_type:'system', body: buildCsDirectorVerdictNote(verdict), …}`. The caller **threads `applyBoxCsDirectorCall`'s result** into the note's `author_outcome` field, so the receipt names the write the specs SDK actually landed — never the LLM's claim.

## Gotchas

- **Pure / test-friendly.** The function takes no DB or runtime context — `runCsDirectorCallJob` handles the `ticket_messages` write, and unit tests (`cs-director-verdict-note.test.ts`) exercise every verdict shape independently.
- **`author_spec` reports the WRITE, not the CLAIM.** On `decision='author_spec'`, the note renders `Authored spec: {slug}` **only when `author_outcome.specWritten === true`** with a concrete `spec_slug` (which may be the SDK's normalized form, not June's seed slug); on a failed write it renders `author_spec FAILED ({reason}) — no spec was written` naming the concrete failure class (`spec_seed_missing_*`, `ticket_id_unresolved`, `author_spec_write_returned_false`, `author_spec_threw`, `handler_threw`). This exists because ticket 2b7ea029 read as `Authored spec: appstle-discount-replace-atomic-and-preserve-manual-discounts` on the thread though no such spec was ever written — the pre-Phase-1 builder consulted `verdict.spec_seed` (the LLM's claim), not the executor's result. See [[../specs/cs-director-spec-claim-must-match-the-actual-write]] Phase 1.
- **Fallback for incomplete payloads.** If a `spec_seed` lacks a `slug` or a remedy lacks a `kind`/`summary`, the function emits a fallback line ("Authored spec: (slug missing — see director_activity for the verdict)") rather than failing — the `director_activity` audit row is the canonical source. **Only fires on a confirmed write** — a failed write always renders the FAILED line.
- **Missing `author_outcome` = legacy back-compat only.** The shipped `runCsDirectorCallJob` call site ALWAYS threads the outcome. The `undefined` fallback exists solely so a pre-Phase-1 unit test caller (e.g. `playbook-supersede-guard.test.ts` header prefix check) doesn't crash.
- **Reasoning normalization.** If the reasoning is empty or whitespace-only, it normalizes to `"(no reasoning recorded)"` rather than a blank line — an explicit audit trail is always present in the note.

## Related

[[cs-director]] · [[cs-director-ticket-transition]] · [[../inngest/cs-director-digest-composer]] · [[../tables/director_activity]] · [[../tables/ticket_messages]]
