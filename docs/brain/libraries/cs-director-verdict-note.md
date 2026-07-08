# libraries/cs-director-verdict-note

The **pure builder** for the internal system note that Phase 1 of [[../specs/cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict]] writes on an escalated ticket after the CS Director (June) rules.

**File:** `src/lib/cs-director-verdict-note.ts`

## What it does

Composes the internal ticket message body (visibility='internal', author_type='system') that surfaces in the ticket thread as a non-customer-visible receipt of the CS Director's review. Before this shipped, an `author_spec` or `approve_remedy` verdict left the ticket open + escalated + note-less — a CS agent scanning the queue could not tell the ticket had already been reviewed by the director.

The note payload encodes the per-verdict handoff:
- **`author_spec`** → the authored spec slug + title (when present)
- **`approve_remedy`** → a one-line summary of the RemedyPlan (kind + human summary)
- **`escalate_founder`** → the reasoning that will be escalated to the CEO

## Exports

- **`buildCsDirectorVerdictNote(verdict: CsDirectorNoteInput): string`** — pure function that composes the internal-note body. Takes a decision (`author_spec` | `approve_remedy` | `escalate_founder`), the reasoning, and the per-verdict output (remedy plan or spec seed). Returns the formatted note body.
- **`CsDirectorDecision`** — type alias for the three verdict shapes.
- **`CsDirectorNoteInput`** — interface for the input shape (decision, reasoning, optional remedy/spec_seed).

## How it's used

**Caller:** `scripts/builder-worker.ts` `runCsDirectorCallJob` — writes the note body to `ticket_messages` as a compare-and-set write after the director's verdict is audited to `director_activity`. The write path is `{visibility:'internal', author_type:'system', body: buildCsDirectorVerdictNote(verdict), …}`.

## Gotchas

- **Pure / test-friendly.** The function takes no DB or runtime context — `runCsDirectorCallJob` handles the `ticket_messages` write, and unit tests (`cs-director-verdict-note.test.ts`) exercise every verdict shape independently.
- **Fallback for incomplete payloads.** If a `spec_seed` lacks a `slug` or a remedy lacks a `kind`/`summary`, the function emits a fallback line ("Authored spec: (slug missing — see director_activity for the verdict)") rather than failing — the `director_activity` audit row is the canonical source.
- **Reasoning normalization.** If the reasoning is empty or whitespace-only, it normalizes to `"(no reasoning recorded)"` rather than a blank line — an explicit audit trail is always present in the note.

## Related

[[cs-director]] · [[cs-director-ticket-transition]] · [[../inngest/cs-director-digest-composer]] · [[../tables/director_activity]] · [[../tables/ticket_messages]]
